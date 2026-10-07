// The names the kill feed showed for players that were not the ones the server listed them under:
// recorded as kill batches come through the real ingest, on any server with the feed, one row per
// player and name; shown on the dossier and found by the Players searches only for the servers the
// caller can open, never another organisation's; and filled once from the history.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	kills,
	organizations,
	playerAliases,
	playerSessions,
	servers,
	siteSettings
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { ingestBatch } from '$lib/server/feed';
import { onKillsIngested } from '$lib/server/feed-events';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { fillAliasHistory, recordAliases } from '$lib/server/aliases';
import { callApi } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const COPIER = '76561198000000901';
const ORIGINAL = '76561198000000902';
const STEADY = '76561198000000903';
const STRANGER = '76561198000000904';

type Named = [steamId: string, name: string];

/** One `killed` event as the game posts it, the players named as the feed shows them. */
const ev = (killer: Named, victim: Named, eventTime = 100) => ({
	eventId: newId(),
	type: 'killed',
	eventTime,
	matchId: 'boot',
	mapName: 'Kavkazi',
	killerName: killer[1],
	killerSteamId: killer[0],
	victimName: victim[1],
	victimSteamId: victim[0],
	cause: 'Id.Item.AK74M',
	distance: 5000,
	contextTags: []
});

describe.skipIf(!hasTestDb)('the names the kill feed showed', () => {
	let env: Env;
	const lists = new Map<string, Named[]>();
	const used: string[] = [];
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		expect(await acquireOrRenew(env, 'kill-feed-names')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`feed-names-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) =>
				method === 'GET' && path === '/v1/players'
					? {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
							text: JSON.stringify({
								players: (lists.get(server.id) ?? []).map(([steamId, name]) => ({
									steamId,
									name,
									faction: null,
									kills: 0
								}))
							})
						}
					: raw(method, path, body, headers);
			return client;
		});
	});

	afterAll(async () => {
		spy.mockRestore();
		for (const id of used) forgetMemory(id);
		await releaseOwnership(env);
	});

	/** The server's player list, as the worker reads it at a look. */
	const listing = async (w: World, serverId: string, ...players: Named[]) => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		used.push(serverId);
		lists.set(serverId, players);
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
	};
	const post = async (serverId: string, at: Date, ...events: ReturnType<typeof ev>[]) => {
		const r = await ingestBatch(env, serverId, { serverId: 'i', serverName: 'x', events }, at);
		await onKillsIngested(env, serverId, r.kills);
	};
	const aliasesOf = (serverId: string) =>
		env.db
			.select()
			.from(playerAliases)
			.where(eq(playerAliases.serverId, serverId))
			.orderBy(playerAliases.name);
	const dossier = async (w: World, who: PrincipalName, serverId: string, steamId: string) => {
		const mod = await import(join(ROUTES, 'servers/[id]/players/[steamId]', '+server.ts'));
		return callApi(mod.GET, w.users[who], { params: { id: serverId, steamId } });
	};
	const feedNamesIn = (answer: { status: number; body: unknown }) =>
		answer.status === 200
			? (answer.body as { dossier: { feedNames: { name: string; holder: string | null }[] } })
					.dossier.feedNames
			: answer.status;
	const seen = async (w: World, who: PrincipalName, serverId: string, q: string) => {
		const { GET } = await import(join(ROUTES, 'servers/[id]/players/seen', '+server.ts'));
		return callApi(GET, w.users[who], {
			params: { id: serverId },
			query: `q=${encodeURIComponent(q)}`
		});
	};
	const orgSeen = async (w: World, who: PrincipalName, q: string) => {
		const { GET } = await import(join(ROUTES, 'orgs/[id]/players', '+server.ts'));
		return callApi(GET, w.users[who], {
			params: { id: w.org.id },
			query: `q=${encodeURIComponent(q)}`
		});
	};
	const found = (answer: { body: unknown }) =>
		(answer.body as { players: { steamId: string; feedNames: string[] }[] }).players.map((p) => [
			p.steamId,
			p.feedNames
		]);
	const session = (serverId: string, steamId: string, name: string, joinedAt: Date) => ({
		serverId,
		steamId,
		name,
		joinedAt,
		lastSeen: joinedAt
	});

	test('a batch records the names its players showed that were not their listed ones, once per player and name, whatever the rules', async () => {
		const w = await seedWorld(env);
		await listing(
			w,
			w.server.id,
			[COPIER, 'Ghostpepper'],
			[ORIGINAL, 'Silver Fox'],
			[STEADY, '[ABC] Steady']
		);
		const first = new Date(Date.now() - 60_000);
		await post(
			w.server.id,
			first,
			ev([COPIER, 'Silver Fox'], [STEADY, '[XYZ] Steady']),
			ev([STRANGER, 'Silver Fox'], [COPIER, 'Tango'], 101),
			ev([COPIER, 'Silver Fox'], [ORIGINAL, 'Silver Fox'], 102)
		);
		expect(
			(await aliasesOf(w.server.id)).map((r) => [
				r.steamId,
				r.name,
				r.holder,
				r.firstSeen.getTime()
			])
		).toEqual([
			[COPIER, 'Silver Fox', ORIGINAL, first.getTime()],
			[COPIER, 'Tango', null, first.getTime()]
		]);
		// shown again later: the same row, its last sighting moved
		const later = new Date();
		await post(w.server.id, later, ev([COPIER, 'Silver Fox'], [STEADY, '[ABC] Steady'], 130));
		const [again] = (await aliasesOf(w.server.id)).filter((r) => r.name === 'Silver Fox');
		expect([again.firstSeen.getTime(), again.lastSeen.getTime(), again.holder]).toEqual([
			first.getTime(),
			later.getTime(),
			ORIGINAL
		]);
	});

	test('the dossier lists them for the servers the viewer can open, newest first, leaving out a name the player also had as their own', async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const at = (m: number) => new Date(now - m * 60_000);
		await env.db
			.insert(playerSessions)
			.values([
				session(w.server.id, COPIER, 'Ghostpepper', at(120)),
				session(w.otherServer.id, COPIER, 'Ghostpepper', at(110)),
				session(w.otherServer.id, COPIER, 'Kestrel', at(100))
			]);
		await recordAliases(env.db, w.server.id, [
			{ steamId: COPIER, name: 'Silver Fox', holder: ORIGINAL, firstSeen: at(60), lastSeen: at(50) }
		]);
		await recordAliases(env.db, w.otherServer.id, [
			{ steamId: COPIER, name: 'Cinder', holder: null, firstSeen: at(40), lastSeen: at(30) },
			{ steamId: COPIER, name: 'Kestrel', holder: null, firstSeen: at(20), lastSeen: at(10) }
		]);
		await recordAliases(env.db, w.otherOrgServer.id, [
			{ steamId: COPIER, name: 'Zulu', holder: null, firstSeen: at(5), lastSeen: at(1) }
		]);
		const names = (list: unknown) =>
			Array.isArray(list)
				? list.map((f: { name: string; holder: string | null }) => [f.name, f.holder])
				: list;
		// both servers for the owner, newest first; Kestrel was their own name on one of them
		expect(names(feedNamesIn(await dossier(w, 'owner', w.server.id, COPIER)))).toEqual([
			['Cinder', null],
			['Silver Fox', ORIGINAL]
		]);
		// a viewer of the first server only, and a member of the second only
		expect(names(feedNamesIn(await dossier(w, 'viewer', w.server.id, COPIER)))).toEqual([
			['Silver Fox', ORIGINAL]
		]);
		expect(names(feedNamesIn(await dossier(w, 'elsewhere', w.otherServer.id, COPIER)))).toEqual([
			['Cinder', null]
		]);
		// a key held to the second server reads that server's names, and gets no dossier on the first
		expect(names(feedNamesIn(await dossier(w, 'keyElsewhere', w.otherServer.id, COPIER)))).toEqual([
			['Cinder', null]
		]);
		expect(feedNamesIn(await dossier(w, 'keyElsewhere', w.server.id, COPIER))).toBe(404);
		// the other organisation's server is never read, and its members get no dossier here
		expect(feedNamesIn(await dossier(w, 'elsewhere', w.server.id, COPIER))).toBe(404);
		expect(feedNamesIn(await dossier(w, 'stranger', w.server.id, COPIER))).toBe(404);
		expect(feedNamesIn(await dossier(w, 'anon', w.server.id, COPIER))).toBe(401);
	});

	test('the searches find a player by a name the feed showed, only on the servers the caller can open', async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const at = (m: number) => new Date(now - m * 60_000);
		await env.db
			.insert(playerSessions)
			.values([
				session(w.server.id, COPIER, 'Ghostpepper', at(120)),
				session(w.server.id, ORIGINAL, 'Silver Fox', at(120)),
				session(w.otherServer.id, COPIER, 'Ghostpepper', at(110)),
				session(w.otherOrgServer.id, COPIER, 'Ghostpepper', at(110))
			]);
		await recordAliases(env.db, w.server.id, [
			{ steamId: COPIER, name: 'Silver Fox', holder: ORIGINAL, firstSeen: at(60), lastSeen: at(50) }
		]);
		await recordAliases(env.db, w.otherServer.id, [
			{ steamId: COPIER, name: 'Cinder', holder: null, firstSeen: at(40), lastSeen: at(30) }
		]);
		await recordAliases(env.db, w.otherOrgServer.id, [
			{ steamId: COPIER, name: 'Zulu', holder: null, firstSeen: at(5), lastSeen: at(1) }
		]);
		// the real one by their name, the copier by the name the feed showed for them
		expect(found(await seen(w, 'viewer', w.server.id, 'silver')).sort()).toEqual(
			[
				[COPIER, ['Silver Fox']],
				[ORIGINAL, []]
			].sort()
		);
		// a name shown on the other server is not this server's to search
		expect(found(await seen(w, 'viewer', w.server.id, 'cinder'))).toEqual([]);
		expect(found(await orgSeen(w, 'owner', 'cinder'))).toEqual([
			[COPIER, ['Cinder', 'Silver Fox']]
		]);
		// nor is a name shown on another organisation's server, for anyone here
		expect(found(await orgSeen(w, 'owner', 'zulu'))).toEqual([]);
		// a member of the second server only searches the second server's names
		const theirs = await orgSeen(w, 'elsewhere', 'cinder');
		expect(theirs.status).toBe(200);
		expect(found(theirs)).toEqual([[COPIER, ['Cinder']]]);
		expect(found(await orgSeen(w, 'elsewhere', 'silver'))).toEqual([]);
	});

	test("a name recorded again keeps the newer sighting's holder, and a long list goes in several statements", async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const at = (m: number) => new Date(now - m * 60_000);
		const silver = (holder: string | null, from: number, to: number) => [
			{ steamId: COPIER, name: 'Silver Fox', holder, firstSeen: at(from), lastSeen: at(to) }
		];
		await recordAliases(env.db, w.server.id, silver(ORIGINAL, 10, 5));
		// an older sighting with another holder (the history arriving after the live row) leaves it
		await recordAliases(env.db, w.server.id, silver(STEADY, 60, 50));
		// a newer one with nobody's name keeps the holder known
		await recordAliases(env.db, w.server.id, silver(null, 2, 1));
		const [row] = await aliasesOf(w.server.id);
		expect([row.holder, row.firstSeen.getTime(), row.lastSeen.getTime()]).toEqual([
			ORIGINAL,
			at(60).getTime(),
			at(1).getTime()
		]);
		// a newer one with another holder replaces it
		await recordAliases(env.db, w.server.id, silver(STEADY, 0.5, 0));
		expect((await aliasesOf(w.server.id))[0].holder).toBe(STEADY);
		// more rows than one statement can bind
		await recordAliases(
			env.db,
			w.otherServer.id,
			Array.from({ length: 2500 }, (_, i) => ({
				steamId: COPIER,
				name: `Name ${i}`,
				holder: null,
				firstSeen: at(1),
				lastSeen: at(1)
			}))
		);
		expect(await aliasesOf(w.otherServer.id)).toHaveLength(2500);
	});

	test('a server whose fill fails leaves the others filled and the history unmarked, for the next try', async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const at = (m: number) => new Date(now - m * 60_000);
		const kill = (serverId: string, minutesAgo: number, killer: Named, victim: Named) => ({
			ts: at(minutesAgo),
			serverId,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			eventTime: 1000 - minutesAgo,
			map: 'Kavkazi',
			killerSteamId: killer[0],
			killerName: killer[1],
			victimSteamId: victim[0],
			victimName: victim[1],
			cause: 'Id.Item.AK74M',
			tags: []
		});
		for (const serverId of [w.server.id, w.otherServer.id]) {
			await env.db
				.insert(playerSessions)
				.values([
					session(serverId, COPIER, 'Ghostpepper', at(120)),
					session(serverId, STEADY, 'Steady', at(120))
				]);
			await env.db
				.insert(kills)
				.values(kill(serverId, 60, [COPIER, 'Juniper'], [STEADY, 'Steady']));
		}
		await env.db.delete(siteSettings).where(eq(siteSettings.key, 'kill_feed_aliases_filled'));
		// the second server's reads fail, as a dropped connection would
		const dialect = (
			env.db as unknown as { dialect: { sqlToQuery(q: unknown): { params: unknown[] } } }
		).dialect;
		const execute = env.db.execute.bind(env.db);
		const broken = spyOn(env.db, 'execute').mockImplementation(((q: unknown) =>
			dialect.sqlToQuery(q).params.includes(w.otherServer.id)
				? Promise.reject(new Error('connection lost'))
				: execute(q as Parameters<typeof execute>[0])) as typeof env.db.execute);
		try {
			expect(await fillAliasHistory(env, { pauseMs: 0 })).toBe('incomplete');
		} finally {
			broken.mockRestore();
		}
		expect((await aliasesOf(w.server.id)).map((r) => r.name)).toEqual(['Juniper']);
		expect(await aliasesOf(w.otherServer.id)).toEqual([]);
		const [mark] = await env.db
			.select()
			.from(siteSettings)
			.where(eq(siteSettings.key, 'kill_feed_aliases_filled'));
		expect(mark).toBeUndefined();
		// the next try fills what was left
		expect(await fillAliasHistory(env, { pauseMs: 0 })).toBe('done');
		expect((await aliasesOf(w.otherServer.id)).map((r) => r.name)).toEqual(['Juniper']);
	});

	test('the history is filled once, from the kills against the sessions open at each, merging with what was recorded live', async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const at = (m: number) => new Date(now - m * 60_000);
		await env.db.insert(playerSessions).values([
			session(w.server.id, COPIER, 'Ghostpepper', at(48 * 60)),
			session(w.server.id, ORIGINAL, '[R-14] Silver Fox', at(48 * 60)),
			// left before the kills: not listed at them
			{ ...session(w.server.id, STRANGER, 'Tango', at(200)), lastSeen: at(190), leftAt: at(190) }
		]);
		const kill = (minutesAgo: number, killer: Named, victim: Named) => ({
			ts: at(minutesAgo),
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			eventTime: 1000 - minutesAgo,
			map: 'Kavkazi',
			killerSteamId: killer[0],
			killerName: killer[1],
			victimSteamId: victim[0],
			victimName: victim[1],
			cause: 'Id.Item.AK74M',
			tags: []
		});
		await env.db.insert(kills).values([
			// more than a day before the others: another UTC day of the fill
			kill(30 * 60, [COPIER, 'Halcyon'], [ORIGINAL, '[R-14] Silver Fox']),
			kill(90, [COPIER, 'Ghostpepper'], [ORIGINAL, '[R-14] Silver Fox']),
			kill(80, [COPIER, 'Silver Fox'], [ORIGINAL, '[R-14] Silver Fox']),
			kill(70, [ORIGINAL, '[R-14] Silver Fox'], [COPIER, 'Tango']),
			kill(60, [STRANGER, 'Nightjar'], [COPIER, 'Ghostpepper'])
		]);
		// recorded live meanwhile, later than the history
		await recordAliases(env.db, w.server.id, [
			{ steamId: COPIER, name: 'Silver Fox', holder: ORIGINAL, firstSeen: at(2), lastSeen: at(1) }
		]);
		await env.db.delete(siteSettings).where(eq(siteSettings.key, 'kill_feed_aliases_filled'));
		// a process that no longer owns the worker leaves it to the next owner, unmarked
		await releaseOwnership(env);
		expect(await fillAliasHistory(env, { pauseMs: 0 })).toBe('stopped');
		expect(await acquireOrRenew(env, 'kill-feed-names')).toBe(true);
		expect(await fillAliasHistory(env, { pauseMs: 0 })).toBe('done');
		expect(
			(await aliasesOf(w.server.id)).map((r) => [
				r.steamId,
				r.name,
				r.holder,
				r.firstSeen.getTime(),
				r.lastSeen.getTime()
			])
		).toEqual([
			[COPIER, 'Halcyon', null, at(30 * 60).getTime(), at(30 * 60).getTime()],
			[COPIER, 'Silver Fox', ORIGINAL, at(80).getTime(), at(1).getTime()],
			[COPIER, 'Tango', null, at(70).getTime(), at(70).getTime()]
		]);
		expect(await fillAliasHistory(env, { pauseMs: 0 })).toBe('already');
		// nothing else came of the fill for this world's players
		const others = await env.db
			.select()
			.from(playerAliases)
			.where(
				and(
					eq(playerAliases.serverId, w.server.id),
					inArray(playerAliases.steamId, [STRANGER, ORIGINAL])
				)
			);
		expect(others).toEqual([]);
	});
});
