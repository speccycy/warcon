// The names the kill feed showed for players that were not the ones the server listed them under
// (player_aliases): what staff see as "in the kill feed as" on the dossier, and what the Players
// searches also match. Recorded as kill batches come in (feed-events.ts), filled once from the
// history, and read only for the servers the viewer can open.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { playerAliases, servers, siteSettings } from './db/schema';
import { forLog } from './http';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { namesShownElse, sessionSweep, type NameReading, type ShownElse } from './name-change';

export interface AliasRow extends ShownElse {
	firstSeen: Date;
	lastSeen: Date;
}

/** The most rows one statement writes: each binds six of the 65,535 parameters a statement may. */
const ROWS_PER_STATEMENT = 1000;

const byKey = (a: AliasRow, b: AliasRow) =>
	a.steamId < b.steamId
		? -1
		: a.steamId > b.steamId
			? 1
			: a.name < b.name
				? -1
				: a.name > b.name
					? 1
					: 0;

/**
 * Adds names to a server's record, one row per player and name: a name shown again widens its
 * first and last sighting, and the holder is the newer sighting's when it has one. Written in key
 * order, so two writers that touch the same rows (overlapping batches, the fill beside a batch)
 * lock them in the same order. Rows must not repeat a player and name.
 */
export async function recordAliases(
	db: DbOrTx,
	serverId: string,
	rows: readonly AliasRow[]
): Promise<void> {
	const sorted = [...rows].sort(byKey);
	for (let i = 0; i < sorted.length; i += ROWS_PER_STATEMENT)
		await db
			.insert(playerAliases)
			.values(sorted.slice(i, i + ROWS_PER_STATEMENT).map((r) => ({ serverId, ...r })))
			.onConflictDoUpdate({
				target: [playerAliases.serverId, playerAliases.steamId, playerAliases.name],
				set: {
					firstSeen: sql`LEAST(${playerAliases.firstSeen}, excluded.first_seen)`,
					lastSeen: sql`GREATEST(${playerAliases.lastSeen}, excluded.last_seen)`,
					holder: sql`CASE WHEN excluded.last_seen >= ${playerAliases.lastSeen}
					                 THEN COALESCE(excluded.holder, ${playerAliases.holder})
					                 ELSE COALESCE(${playerAliases.holder}, excluded.holder) END`
				}
			});
}

/** One name the feed showed for a player, over the servers asked for. */
export interface FeedName {
	name: string;
	/** another listed player whose name it read as, when it was someone else's */
	holder: string | null;
	lastSeen: string;
}

/** The most names a dossier lists, newest first. */
const FEED_NAMES_MAX = 200;

/**
 * A player's names in the kill feed on these servers (the ones the viewer can open), newest first,
 * leaving out a name they also played under as their own there; `total` counts them all.
 */
export async function feedNamesOf(
	env: Env,
	serverIds: readonly string[],
	steamId: string
): Promise<{ names: FeedName[]; total: number }> {
	if (!serverIds.length) return { names: [], total: 0 };
	const rows = await env.db.execute<{
		name: string;
		holder: string | null;
		lastSeen: Date;
		total: number;
	}>(sql`
		SELECT a.name,
		       (array_agg(a.holder ORDER BY a.last_seen DESC) FILTER (WHERE a.holder IS NOT NULL))[1] AS holder,
		       MAX(a.last_seen) AS "lastSeen",
		       COUNT(*) OVER ()::int AS total
		  FROM player_aliases a
		 WHERE a.steam_id = ${steamId} AND a.server_id IN ${serverIds}
		   AND NOT EXISTS (SELECT 1 FROM player_sessions s
		                    WHERE s.steam_id = a.steam_id AND s.server_id IN ${serverIds}
		                      AND s.name = a.name)
		 GROUP BY a.name
		 ORDER BY MAX(a.last_seen) DESC
		 LIMIT ${FEED_NAMES_MAX}`);
	return {
		names: rows.map((r) => ({
			name: r.name,
			holder: r.holder,
			lastSeen: new Date(r.lastSeen).toISOString()
		})),
		total: rows[0]?.total ?? 0
	};
}

// ---- the history ---------------------------------------------------------------------------------

/** The site_settings key that says the history has been filled, and up to when. */
const FILLED = 'kill_feed_aliases_filled';
const DAY_MS = 86_400_000;

/**
 * Fills the record from the kill feed's history, once: each server's kills, a day at a time, held
 * against the sessions open at each (the same replay as the Name change watch's dry run), with a
 * pause between days so the database is never busy with it. Live recording meanwhile only merges
 * with it. Stops as soon as this process no longer owns the worker; a server that fails is left for
 * the next try. Either way the next try starts over, which writes nothing twice. Marks itself done
 * once every server is.
 */
export async function fillAliasHistory(
	env: Env,
	opts: { pauseMs?: number } = {}
): Promise<'done' | 'already' | 'stopped' | 'incomplete'> {
	const [mark] = await env.db.execute<{ key: string }>(
		sql`SELECT key FROM site_settings WHERE key = ${FILLED}`
	);
	if (mark) return 'already';
	const until = new Date();
	const list = await env.db.select({ id: servers.id }).from(servers).orderBy(servers.id);
	// One server's failure does not stop the others; the fill is done only once every one is.
	let complete = true;
	for (const s of list) {
		if (!isOwner()) return 'stopped';
		try {
			if (!(await fillServer(env, s.id, until.getTime(), opts.pauseMs ?? 50))) return 'stopped';
		} catch (err) {
			if (err instanceof LostOwnership) return 'stopped';
			console.warn(`[warcon] filling the kill feed names of ${s.id}:`, forLog(err));
			complete = false;
		}
	}
	if (!complete) return 'incomplete';
	if (!isOwner()) return 'stopped';
	await withOwnedTransaction(env, (tx) =>
		tx
			.insert(siteSettings)
			.values({ key: FILLED, value: { through: until.toISOString() } })
			.onConflictDoNothing()
	);
	return 'done';
}

/** One server's history; false when this process stopped owning the worker on the way. */
async function fillServer(
	env: Env,
	serverId: string,
	until: number,
	pauseMs: number
): Promise<boolean> {
	const sessions = await env.db.execute<{
		steamId: string;
		name: string;
		joinedAt: Date;
		leftAt: Date | null;
	}>(sql`
		SELECT steam_id AS "steamId", name, joined_at AS "joinedAt", left_at AS "leftAt"
		  FROM player_sessions WHERE server_id = ${serverId}
		 ORDER BY joined_at`);
	if (!sessions.length) return true;
	const listedAt = sessionSweep(
		sessions.map((s) => ({
			steamId: s.steamId,
			name: s.name,
			joinedAt: s.joinedAt,
			leftAt: s.leftAt
		}))
	);
	const readings = new Map<string, NameReading>();
	const found = new Map<string, AliasRow>();
	const start = new Date(sessions[0].joinedAt).getTime();
	for (let from = start - (start % DAY_MS); from < until; from += DAY_MS) {
		const to = Math.min(from + DAY_MS, until);
		const kills = await env.db.execute<{
			ts: Date;
			killer: string | null;
			killerName: string | null;
			victim: string;
			victimName: string;
		}>(sql`
			SELECT ts, killer_steam_id AS killer, killer_name AS "killerName",
			       victim_steam_id AS victim, victim_name AS "victimName"
			  FROM kills
			 WHERE server_id = ${serverId} AND ts >= ${new Date(from)} AND ts < ${new Date(to)}
			 ORDER BY ts, event_time`);
		for (const k of kills) {
			const at = new Date(k.ts).getTime();
			const shown = [
				...(k.killer && k.killerName !== null ? [{ steamId: k.killer, name: k.killerName }] : []),
				...(k.victim !== k.killer ? [{ steamId: k.victim, name: k.victimName }] : [])
			];
			for (const a of namesShownElse(shown, listedAt(at), readings)) {
				const key = `${a.steamId}\n${a.name}`;
				const was = found.get(key);
				found.set(key, {
					...a,
					holder: a.holder ?? was?.holder ?? null,
					firstSeen: was?.firstSeen ?? new Date(at),
					lastSeen: new Date(at)
				});
			}
		}
		if (pauseMs && kills.length) await new Promise((r) => setTimeout(r, pauseMs));
		if (!isOwner()) return false;
	}
	if (found.size)
		await withOwnedTransaction(env, (tx) => recordAliases(tx, serverId, [...found.values()]));
	return true;
}

/** How long after a fill that did not finish it is tried again. */
const FILL_RETRY_MS = 10 * 60_000;
let filling: Promise<unknown> | null = null;
let filled = false;
let retryAt = 0;

/**
 * Starts filling the history in the background (called at every beat while this process owns the
 * worker), unless it is running, done, or waiting to try again after a fill that did not finish.
 */
export function startAliasFill(env: Env): void {
	if (filled || filling || Date.now() < retryAt) return;
	filling = fillAliasHistory(env)
		.then((r) => {
			if (r === 'done' || r === 'already') filled = true;
			else retryAt = Date.now() + FILL_RETRY_MS;
		})
		.catch((err) => {
			if (!(err instanceof LostOwnership))
				console.warn('[warcon] filling the kill feed names:', forLog(err));
			retryAt = Date.now() + FILL_RETRY_MS;
		})
		.finally(() => {
			filling = null;
		});
}
