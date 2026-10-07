// Seasons on a real database: an owner's changes to the organisation's own seasons through the
// routes (a start in the past, a start taken, a started season's start, a deletion, another
// organisation's season named by id, the audit rows), what the boards open on, a board over a
// finished season (cut at its end, no last seen, its winners) and over the one running, what the
// picker offers (never a season still to come, never another organisation's), the cache shared by
// `current` and its season, a career's seasons and places, a season's export name, and a purge
// forgetting a season's winners.
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	matches,
	matchPlayers,
	organizations,
	playerSessions,
	seasons,
	servers
} from '$lib/server/db/schema';
import { forgetBoards, loadBoard, loadCareer } from '$lib/server/leaderboards';
import { forgetSeasons } from '$lib/server/seasons';
import { parseBoardQuery, type BoardView } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { callApi, callRaw, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET as listRoute, POST as createRoute } from '../routes/api/orgs/[id]/seasons/+server';
import {
	DELETE as deleteRoute,
	PATCH as updateRoute
} from '../routes/api/orgs/[id]/seasons/[seasonId]/+server';
import { PATCH as orgRoute } from '../routes/api/orgs/[id]/+server';
import { GET as panelBoard } from '../routes/api/servers/[id]/leaderboard/+server';
import { GET as exportRoute } from '../routes/api/servers/[id]/leaderboard/export/+server';
import { GET as publicBoard } from '../routes/api/public/servers/[id]/leaderboard/+server';
import { POST as purge } from '../routes/api/servers/[id]/stats/purge/+server';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST = '76561198000004001';
const SECOND = '76561198000004002';
const LATE = '76561198000004003';
const scores = [
	{ name: 'Valkyra', score: 3 },
	{ name: 'Lonestar', score: 1 }
];

describe.skipIf(!hasTestDb)('seasons', () => {
	let env: Env;
	let w: World;
	const now = Date.now();
	// Spring is over, Summer runs, Autumn is still to come; Theirs is another organisation's.
	const spring = { id: `spring-${now}`, from: now - 20 * DAY };
	const summer = { id: `summer-${now}`, from: now - 10 * DAY };
	const autumn = { id: `autumn-${now}`, from: now + 5 * DAY };
	const theirs = { id: `theirs-${now}` };

	const match = async (endedAt: number, lines: [string, string, number, number][]) => {
		const [m] = await env.db
			.insert(matches)
			.values({
				serverId: w.server.id,
				startedAt: new Date(endedAt - HOUR),
				endedAt: new Date(endedAt),
				map: 'Europe',
				finalScores: scores,
				winner: 'Valkyra'
			})
			.returning({ id: matches.id });
		await env.db.insert(matchPlayers).values(
			lines.map(([steamId, faction, kills, deaths]) => ({
				matchId: m.id,
				serverId: w.server.id,
				steamId,
				name: steamId.slice(-4),
				faction,
				seconds: 3000,
				kills,
				deaths
			}))
		);
	};
	const session = (steamId: string, joinedAt: number, minutes: number) =>
		env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId,
			name: `Player ${steamId.slice(-1)}`,
			joinedAt: new Date(joinedAt),
			lastSeen: new Date(joinedAt + minutes * 60_000),
			leftAt: new Date(joinedAt + minutes * 60_000)
		});
	const board = (range: string, orgId = w.org.id) =>
		loadBoard(
			env,
			[w.server.id],
			parseBoardQuery(new URLSearchParams({ range, minMinutes: '0' })),
			orgId
		);
	const rowsOf = (b: BoardView) => b.rows.map((r) => [r.steamId, r.kills, r.matches]);

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		// past starts, which the routes refuse, written as the seasons would stand by now
		await env.db.insert(seasons).values([
			{ id: spring.id, orgId: w.org.id, name: 'Spring', startsAt: new Date(spring.from) },
			{ id: summer.id, orgId: w.org.id, name: 'Summer', startsAt: new Date(summer.from) },
			{ id: autumn.id, orgId: w.org.id, name: 'Autumn', startsAt: new Date(autumn.from) },
			{ id: theirs.id, orgId: w.otherOrg.id, name: 'Theirs', startsAt: new Date(now - 30 * DAY) }
		]);
		// Spring: FIRST plays ten matches and wins them all, SECOND one of them, on the other side
		for (let i = 0; i < 10; i++)
			await match(spring.from + (i + 1) * 20 * HOUR, [
				[FIRST, 'Valkyra', 3, 1],
				...(i === 0 ? [[SECOND, 'Lonestar', 10, 10] as [string, string, number, number]] : [])
			]);
		await session(FIRST, spring.from + DAY, 180);
		await session(SECOND, spring.from + DAY, 60);
		// the moment Summer starts belongs to Summer, not Spring
		await match(summer.from, [[SECOND, 'Lonestar', 100, 1]]);
		// Summer: LATE's first visit, FIRST once more
		await match(now - 2 * DAY, [
			[LATE, 'Valkyra', 50, 5],
			[FIRST, 'Lonestar', 5, 5]
		]);
		await session(LATE, now - 2 * DAY - HOUR, 60);
		forgetSeasons();
	});

	afterEach(() => {
		forgetBoards();
		forgetSeasons();
	});

	test('a finished season is cut at its end, with no last seen, and its winners', async () => {
		const b = await board(`s:${spring.id}`);
		expect(b.when).toMatchObject({ range: `s:${spring.id}`, finished: true });
		expect(b.when.season).toMatchObject({ name: 'Spring', kind: 'custom' });
		expect(b.when.season?.endsAt).toBe(new Date(summer.from).toISOString());
		expect(rowsOf(b)).toEqual([
			[FIRST, 30, 10],
			[SECOND, 10, 1]
		]);
		expect(b.rows.map((r) => [r.minutes, r.lastSeen])).toEqual([
			[180, null],
			[60, null]
		]);
		expect(b.winners).toEqual({
			kills: [
				{ steamId: FIRST, name: 'Player 1', value: 30 },
				{ steamId: SECOND, name: 'Player 2', value: 10 }
			],
			// SECOND played one match: under the K/D floor
			kd: [{ steamId: FIRST, name: 'Player 1', value: 3 }],
			playtime: [
				{ steamId: FIRST, name: 'Player 1', value: 180 },
				{ steamId: SECOND, name: 'Player 2', value: 60 }
			],
			wins: [{ steamId: FIRST, name: 'Player 1', value: 10 }]
		});
	});

	test('the season running reads to now, with last seen and no winners', async () => {
		const b = await board(`s:${summer.id}`);
		expect(b.when).toMatchObject({ range: `s:${summer.id}`, finished: false });
		expect(rowsOf(b)).toEqual([
			[SECOND, 100, 1],
			[LATE, 50, 1],
			[FIRST, 5, 1]
		]);
		expect(b.rows.find((r) => r.steamId === LATE)?.lastSeen).not.toBeNull();
		expect(b.winners).toBeNull();
	});

	test('the picker offers the seasons that have started, never one to come or another organisation’s', async () => {
		const b = await board('7d');
		const keys = b.seasons.map((s) => s.key);
		expect(keys).toContain(spring.id);
		expect(keys).toContain(summer.id);
		expect(keys).toContain('wardogs-1');
		expect(keys).not.toContain(autumn.id);
		expect(keys).not.toContain(theirs.id);
		// newest first
		expect(keys.indexOf(summer.id)).toBeLessThan(keys.indexOf(spring.id));
		// a season to come, or another organisation's, named in the range is the default board
		for (const range of [`s:${autumn.id}`, `s:${theirs.id}`, 's:nothing'])
			expect((await board(range)).when.season?.kind).toBe('official');
		// and Theirs is its own organisation's board
		const other = await loadBoard(
			env,
			[w.otherOrgServer.id],
			parseBoardQuery(new URLSearchParams({ range: `s:${theirs.id}` })),
			w.otherOrg.id
		);
		expect(other.when.season?.name).toBe('Theirs');
	});

	test('the boards open on what the owner picked, at once; anything else is refused', async () => {
		expect((await board('current')).when.season?.kind).toBe('official');
		const set = (boardOpens: unknown, who = w.users.owner) =>
			callApi(orgRoute, who, { method: 'PATCH', params: { id: w.org.id }, body: { boardOpens } });
		expect((await set('nonsense')).status).toBe(400);
		expect((await set('custom', w.users.admin)).status).toBe(403);
		expect((await set('custom')).status).toBe(200);
		expect((await board('current')).when.range).toBe(`s:${summer.id}`);
		expect((await set('30d')).status).toBe(200);
		expect((await board('current')).when.range).toBe('30d');
		expect((await set('all')).status).toBe(200);
		expect((await board('current')).when).toMatchObject({ range: 'all', season: null });
		expect((await set('official')).status).toBe(200);
		const rows = await env.db
			.select({ detail: auditLog.detail })
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.update')))
			.orderBy(auditLog.id);
		expect(
			rows.map((r) => (r.detail as { boardOpens?: string } | null)?.boardOpens).filter(Boolean)
		).toEqual(['custom', '30d', 'all', 'official']);
	});

	test('`current` and the season it names are one board, read once', async () => {
		await env.db
			.update(organizations)
			.set({ boardOpens: 'custom' })
			.where(eq(organizations.id, w.org.id));
		forgetSeasons();
		const n = { execute: 0 };
		const db = new Proxy(env.db, {
			get(target, prop, receiver) {
				if (prop !== 'execute') return Reflect.get(target, prop, receiver);
				return (...args: unknown[]) => {
					n.execute++;
					return (target.execute as (...a: unknown[]) => unknown)(...args);
				};
			}
		});
		const counted = { ...env, db } as Env;
		const q = (range: string) => parseBoardQuery(new URLSearchParams({ range, minMinutes: '0' }));
		const a = await loadBoard(counted, [w.server.id], q('current'), w.org.id);
		const b = await loadBoard(counted, [w.server.id], q(`s:${summer.id}`), w.org.id);
		expect(n.execute).toBe(1);
		expect(b.rows).toEqual(a.rows);
		// each answers with the query it was asked
		expect([a.query.range, b.query.range]).toEqual(['current', `s:${summer.id}`]);
		await env.db
			.update(organizations)
			.set({ boardOpens: 'official' })
			.where(eq(organizations.id, w.org.id));
	});

	test("a career counts each season's matches and the places won on this server", async () => {
		const career = (steamId: string) =>
			loadCareer(env, {
				serverId: w.server.id,
				orgId: w.org.id,
				ids: [w.server.id],
				nameOf: new Map(),
				steamId
			});
		const first = await career(FIRST);
		const of = (c: typeof first, key: string) => c.seasons.find((s) => s.season.key === key);
		expect(of(first, spring.id)).toMatchObject({
			matches: 10,
			wins: 10,
			losses: 0,
			kills: 30,
			deaths: 10,
			places: [
				{ category: 'kills', place: 1 },
				{ category: 'kd', place: 1 },
				{ category: 'playtime', place: 1 },
				{ category: 'wins', place: 1 }
			]
		});
		expect(of(first, summer.id)).toMatchObject({ matches: 1, kills: 5, losses: 1, places: [] });
		expect(of(first, autumn.id)).toBeUndefined();
		const second = await career(SECOND);
		expect(of(second, spring.id)?.places).toEqual([
			{ category: 'kills', place: 2 },
			{ category: 'playtime', place: 2 }
		]);
		expect(of(second, summer.id)).toMatchObject({ matches: 1, kills: 100, places: [] });
		// another server's career page shows no places won here
		const elsewhere = await loadCareer(env, {
			serverId: w.otherServer.id,
			orgId: w.org.id,
			ids: [w.server.id, w.otherServer.id],
			nameOf: new Map(),
			steamId: FIRST
		});
		expect(of(elsewhere, spring.id)).toMatchObject({ matches: 10, places: [] });
	});

	test("an owner's seasons through the routes: future starts only, and a started one stays put", async () => {
		const owner = w.users.owner;
		const params = { id: w.org.id };
		const create = (body: unknown) => callApi(createRoute, owner, { method: 'POST', params, body });
		const tomorrow = new Date(Math.floor(now / DAY) * DAY + DAY).toISOString();
		expect(
			(await create({ name: 'Past', startsAt: new Date(now - DAY).toISOString() })).status
		).toBe(400);
		expect((await create({ name: '  ', startsAt: tomorrow })).status).toBe(400);
		expect((await create({ name: 'Winter', startsAt: 'soon' })).status).toBe(400);
		const made = await create({ name: 'Winter', startsAt: tomorrow });
		expect(made.status).toBe(201);
		const id = (made.body as { season: { id: string } }).season.id;
		const clash = await create({ name: 'Also winter', startsAt: tomorrow });
		expect(clash.status).toBe(400);
		expect(clash.message).toBe('Another of your seasons starts at that moment.');

		const list = await callApi(listRoute, owner, { params });
		const listed = (list.body as { seasons: { key: string; kind: string }[]; opens: string })
			.seasons;
		expect(listed.filter((s) => s.kind === 'custom').map((s) => s.key)).toEqual([
			spring.id,
			summer.id,
			id,
			autumn.id
		]);
		expect(JSON.stringify(list.body)).not.toContain('createdBy');

		const update = (seasonId: string, body: unknown, orgId = w.org.id) =>
			callApi(updateRoute, owner, { method: 'PATCH', params: { id: orgId, seasonId }, body });
		const remove = (seasonId: string, orgId = w.org.id) =>
			callApi(deleteRoute, owner, { method: 'DELETE', params: { id: orgId, seasonId } });
		expect((await update(spring.id, { name: 'Spring league' })).status).toBe(200);
		const moved = await update(spring.id, { startsAt: tomorrow });
		expect(moved.status).toBe(400);
		expect((await remove(spring.id)).status).toBe(400);
		const onto = await update(id, { startsAt: new Date(autumn.from).toISOString() });
		expect([onto.status, onto.message]).toEqual([
			400,
			'Another of your seasons starts at that moment.'
		]);
		expect((await update(id, { startsAt: new Date(now + 3 * DAY).toISOString() })).status).toBe(
			200
		);
		expect((await remove(id)).status).toBe(200);

		// another organisation's season, by id, through this one's routes or its own
		expect((await update(theirs.id, { name: 'Mine now' })).status).toBe(404);
		expect((await remove(theirs.id)).status).toBe(404);
		expect((await update(theirs.id, { name: 'Mine now' }, w.otherOrg.id)).status).toBe(404);
		expect((await remove(theirs.id, w.otherOrg.id)).status).toBe(404);
		const [kept] = await env.db
			.select({ name: seasons.name })
			.from(seasons)
			.where(eq(seasons.id, theirs.id));
		expect(kept.name).toBe('Theirs');

		const rows = await env.db
			.select({ action: auditLog.action, target: auditLog.target, category: auditLog.category })
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.category, 'org')))
			.orderBy(auditLog.id);
		expect(rows.filter((r) => r.action.startsWith('season.'))).toEqual([
			{ action: 'season.create', target: 'Winter', category: 'org' },
			{ action: 'season.update', target: 'Spring league', category: 'org' },
			{ action: 'season.update', target: 'Winter', category: 'org' },
			{ action: 'season.delete', target: 'Winter', category: 'org' }
		]);
		await env.db.update(seasons).set({ name: 'Spring' }).where(eq(seasons.id, spring.id));
	});

	test("the panel and public boards answer a season's range; the export is named after it", async () => {
		const query = `range=s:${spring.id}&minMinutes=0`;
		const panel = await callApi(panelBoard, w.users.viewer, { params: { id: w.server.id }, query });
		expect(panel.status).toBe(200);
		expect((panel.body as BoardView).when.season?.name).toBe('Spring');
		expect((panel.body as BoardView).winners?.kills[0].steamId).toBe(FIRST);
		const file = await callRaw(exportRoute, w.users.viewer, { params: { id: w.server.id }, query });
		expect(file.headers.get('content-disposition')).toMatch(
			/filename="[a-z0-9-]+-leaderboard-spring-\d{4}-\d{2}-\d{2}\.csv"$/
		);
		await file.body?.cancel();
		// public once the organisation and the server allow it
		const closed = await callApi(publicBoard, null, { params: { id: w.server.id }, query });
		expect(closed.status).toBe(404);
		await env.db
			.update(organizations)
			.set({ allowPublicLeaderboards: true })
			.where(eq(organizations.id, w.org.id));
		await env.db
			.update(servers)
			.set({ publicLeaderboards: true })
			.where(eq(servers.id, w.server.id));
		const open = await callApi(publicBoard, null, { params: { id: w.server.id }, query });
		expect(open.status).toBe(200);
		const view = open.body as BoardView;
		expect(view.when.season?.name).toBe('Spring');
		expect(view.seasons.map((s) => s.key)).not.toContain(autumn.id);
		await env.db
			.update(servers)
			.set({ publicLeaderboards: false })
			.where(eq(servers.id, w.server.id));
	});

	test("a purge forgets a finished season's winners at once", async () => {
		expect((await board(`s:${spring.id}`)).winners?.kills.length).toBe(2);
		const [{ name }] = await env.db
			.select({ name: servers.name })
			.from(servers)
			.where(eq(servers.id, w.server.id));
		const done = await callApi(purge, w.users.owner, {
			method: 'POST',
			params: { id: w.server.id },
			body: { name }
		});
		expect(done.status).toBe(200);
		const after = await board(`s:${spring.id}`);
		expect(after.winners?.kills).toEqual([]);
		// sessions stay through a purge, and so does playtime
		expect(after.winners?.playtime.map((p) => p.steamId)).toEqual([FIRST, SECOND]);
	});
});
