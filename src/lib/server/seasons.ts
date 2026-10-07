// An organisation's seasons for its boards: the official ones from $lib/seasons and the
// community's own (the seasons table), chained per kind; what its boards open on and the columns
// its public boards leave out; which window of the kept history a board reads; and an owner's
// changes to the community's seasons, each audited. A season that has not started is listed in
// the Seasons tab but never read.
import { and, asc, count, eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { organizations, seasons } from './db/schema';
import {
	chainSeasons,
	currentSeason,
	isBoardOpens,
	isFinished,
	isStarted,
	OFFICIAL_SEASONS,
	type BoardOpens,
	type Season
} from '$lib/seasons';
import {
	isFixedRange,
	rangeStart,
	storedHidden,
	type BoardColumn,
	type BoardRange,
	type FixedRange
} from '$lib/leaderboard';

export interface OrgSeasons {
	/** the official seasons, then the community's own, each kind in start order */
	seasons: Season[];
	opens: BoardOpens;
	/** the columns its public boards leave out */
	hidden: BoardColumn[];
}

/** Read once a minute per organisation: every board and career asks. */
const TTL_MS = 60_000;
const CACHE_MAX = 2_000;
const cache = new Map<string, { until: number; value: Promise<OrgSeasons> }>();

/** Forgets one organisation's seasons (they changed), or everyone's. */
export function forgetSeasons(orgId?: string): void {
	if (orgId === undefined) cache.clear();
	else cache.delete(orgId);
}

export async function orgSeasons(env: Env, orgId: string): Promise<OrgSeasons> {
	const now = Date.now();
	const hit = cache.get(orgId);
	if (hit && hit.until > now) return hit.value;
	const value = readSeasons(env, orgId);
	cache.set(orgId, { until: now + TTL_MS, value });
	value.catch(() => {
		if (cache.get(orgId)?.value === value) cache.delete(orgId);
	});
	if (cache.size > CACHE_MAX)
		for (const [k, e] of cache) if (e.until <= now || cache.size > CACHE_MAX) cache.delete(k);
	return value;
}

/** Read now, not kept: the Seasons tab shows an owner's change at once. */
export const listSeasons = (env: Env, orgId: string): Promise<OrgSeasons> =>
	readSeasons(env, orgId);

async function readSeasons(env: Env, orgId: string): Promise<OrgSeasons> {
	const [[org], own] = await Promise.all([
		env.db
			.select({ opens: organizations.boardOpens, hidden: organizations.boardHidden })
			.from(organizations)
			.where(eq(organizations.id, orgId)),
		env.db
			.select({ key: seasons.id, name: seasons.name, startsAt: seasons.startsAt })
			.from(seasons)
			.where(eq(seasons.orgId, orgId))
			.orderBy(asc(seasons.startsAt))
	]);
	return {
		seasons: [
			...chainSeasons('official', OFFICIAL_SEASONS),
			...chainSeasons(
				'custom',
				own.map((s) => ({ key: s.key, name: s.name, startsAt: s.startsAt.toISOString() }))
			)
		],
		opens: isBoardOpens(org?.opens) ? org.opens : 'official',
		hidden: storedHidden(org?.hidden)
	};
}

/**
 * The stretch of history a board reads: from `from` (null: the beginning) to `to` (null: now).
 * A season that is still running reads to now, as a rolling range does; only a finished one has
 * an end, and then its board no longer changes.
 */
export interface BoardWindow {
	range: FixedRange | `s:${string}`;
	from: Date | null;
	to: Date | null;
	season: Season | null;
	finished: boolean;
}

export const fixedWindow = (range: FixedRange, now = Date.now()): BoardWindow => ({
	range,
	from: rangeStart(range, now),
	to: null,
	season: null,
	finished: false
});

export const seasonWindow = (s: Season, now = Date.now()): BoardWindow => {
	const finished = isFinished(s, now);
	return {
		range: `s:${s.key}`,
		from: new Date(s.startsAt),
		to: finished ? new Date(s.endsAt!) : null,
		season: s,
		finished
	};
};

/**
 * Which window a board's range names: a fixed range as itself; a season that has started as its
 * span; anything else (`current`, or a season unknown or not begun) as what the organisation's
 * boards open on, its current official season unless it chose otherwise.
 */
export function resolveWindow(range: BoardRange, os: OrgSeasons, now = Date.now()): BoardWindow {
	if (isFixedRange(range)) return fixedWindow(range, now);
	if (range.startsWith('s:')) {
		const key = range.slice(2);
		const s = os.seasons.find((x) => x.key === key && isStarted(x, now));
		if (s) return seasonWindow(s, now);
	}
	const pick =
		os.opens === 'custom'
			? (currentSeason(os.seasons, 'custom', now) ?? currentSeason(os.seasons, 'official', now))
			: os.opens === 'official'
				? currentSeason(os.seasons, 'official', now)
				: null;
	if (pick) return seasonWindow(pick, now);
	return fixedWindow(os.opens === '30d' ? '30d' : 'all', now);
}

/** The window a board's range names for this organisation now, for an export. */
export const boardWindow = async (
	env: Env,
	orgId: string,
	range: BoardRange
): Promise<BoardWindow> => resolveWindow(range, await orgSeasons(env, orgId));

/** The seasons a board's picker offers: those that have started, the newest first. */
export const pickable = (os: OrgSeasons, now = Date.now()): Season[] =>
	os.seasons
		.filter((s) => isStarted(s, now))
		.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

// ---- a community's own seasons -------------------------------------------------------------

const NAME_MAX = 40;
const SEASONS_MAX = 100;

function seasonName(v: unknown): string {
	const name = str(v, NAME_MAX).trim();
	if (!name) throw new ApiError(400, 'Give the season a name.');
	return name;
}

/** A start still to come: a season's standings must not change under anyone already reading them. */
function futureStart(v: unknown): Date {
	const t = typeof v === 'string' ? Date.parse(v) : NaN;
	if (!Number.isFinite(t)) throw new ApiError(400, 'Pick when the season starts.');
	if (t <= Date.now())
		throw new ApiError(400, 'A season starts in the future: pick a later date or time.');
	return new Date(t);
}

/** Another of the organisation's seasons starts at that moment: its unique index refused the write. */
const startTaken = (err: unknown): boolean => {
	const cause = (err as { cause?: { errno?: unknown; constraint?: unknown } })?.cause;
	return cause?.errno === '23505' && cause.constraint === 'seasons_org_start_uidx';
};

async function ownSeason(env: Env, org: OrgRow, seasonId: string) {
	const [row] = await env.db
		.select()
		.from(seasons)
		.where(and(eq(seasons.id, seasonId), eq(seasons.orgId, org.id)));
	if (!row) throw new ApiError(404, 'Season not found.');
	return row;
}

export async function createSeason(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<{ id: string }> {
	const name = seasonName(body.name);
	const startsAt = futureStart(body.startsAt);
	const [{ n }] = await env.db
		.select({ n: count() })
		.from(seasons)
		.where(eq(seasons.orgId, org.id));
	if (n >= SEASONS_MAX)
		throw new ApiError(400, `An organisation keeps at most ${SEASONS_MAX} seasons of its own.`);
	const id = newId();
	try {
		await env.db
			.insert(seasons)
			.values({ id, orgId: org.id, name, startsAt, createdBy: actor.apiKey ? null : actor.id });
	} catch (err) {
		if (startTaken(err)) throw new ApiError(400, 'Another of your seasons starts at that moment.');
		throw err;
	}
	forgetSeasons(org.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'season.create',
		outcome: 'ok',
		target: name,
		detail: { orgId: org.id, seasonId: id, startsAt: startsAt.toISOString() }
	});
	return { id };
}

/** A new name at any time; a new start only before the season has begun, and still to come. */
export async function updateSeason(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	seasonId: string,
	body: Record<string, unknown>
): Promise<void> {
	const row = await ownSeason(env, org, seasonId);
	const set: Partial<typeof seasons.$inferInsert> = {};
	const detail: Record<string, unknown> = { orgId: org.id, seasonId };
	if (body.name !== undefined) {
		set.name = seasonName(body.name);
		detail.from = row.name;
	}
	if (body.startsAt !== undefined) {
		if (row.startsAt.getTime() <= Date.now())
			throw new ApiError(
				400,
				'This season has started: its start stays put, so its standings never move.'
			);
		set.startsAt = futureStart(body.startsAt);
		detail.startsAt = set.startsAt.toISOString();
	}
	if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
	try {
		await env.db.update(seasons).set(set).where(eq(seasons.id, row.id));
	} catch (err) {
		if (startTaken(err)) throw new ApiError(400, 'Another of your seasons starts at that moment.');
		throw err;
	}
	forgetSeasons(org.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'season.update',
		outcome: 'ok',
		target: set.name ?? row.name,
		detail
	});
}

/** Only a season that has not begun: one that has keeps its standings, and its winners. */
export async function deleteSeason(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	seasonId: string
): Promise<void> {
	const row = await ownSeason(env, org, seasonId);
	if (row.startsAt.getTime() <= Date.now())
		throw new ApiError(400, 'This season has started: it stays, with its standings and winners.');
	await env.db.delete(seasons).where(eq(seasons.id, row.id));
	forgetSeasons(org.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'season.delete',
		outcome: 'ok',
		target: row.name,
		detail: { orgId: org.id, seasonId: row.id, startsAt: row.startsAt.toISOString() }
	});
}
