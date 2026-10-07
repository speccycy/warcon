// A player's stats in a rule's messages are their line on this server's all-time leaderboard, or on
// the organisation's: the same numbers those boards show, never another server's or another
// organisation's, read once per player and side per look, and only for a message that uses them. A
// whisper about a kill gets them too, through the kill feed.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	matches,
	matchPlayers,
	outbox,
	playerSessions,
	samples,
	triggers
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { onKillsIngested } from '$lib/server/feed-events';
import { ingestBatch } from '$lib/server/feed';
import { loadBoard, playerStats } from '$lib/server/leaderboards';
import {
	dryRun,
	evaluateTriggers,
	invalidateTriggers,
	statsReader,
	validateConfig,
	type TickContext
} from '$lib/server/triggers';
import { NO_STATS } from '$lib/server/message-vars';
import { newId } from '$lib/server/http';
import type { TriggerRow } from '$lib/server/db/schema';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const OWL = { id: '76561198000000801', name: '[ABC] Night Owl' };
const GUNNER = { id: '76561198000000802', name: 'Gunner' };
const MATE = { id: '76561198000000803', name: 'Mate' };
const NEW = { id: '76561198000000804', name: 'Newcomer' };
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const player = (p: typeof OWL): Player => ({
	name: p.name,
	steamId: p.id,
	faction: 'Valkyra',
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: 60
});

describe.skipIf(!hasTestDb)('stats in messages', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'message-stats test')).toBe(true);
		const scores = (a: number, b: number) => [
			{ name: 'Valkyra', score: a },
			{ name: 'Lonestar', score: b }
		];
		// Two matches over on this server (one won, one lost), one still on, one over on the org's
		// other server and one on another organisation's.
		const [won, lost, onNow, other, theirs] = await env.db
			.insert(matches)
			.values([
				{
					serverId: w.server.id,
					startedAt: ago(3 * 1440 * MIN),
					endedAt: ago(3 * 1440 * MIN - 40 * MIN),
					map: 'Kavkazi',
					finalScores: scores(100, 50),
					winner: 'Valkyra'
				},
				{
					serverId: w.server.id,
					startedAt: ago(2 * 1440 * MIN),
					endedAt: ago(2 * 1440 * MIN - 40 * MIN),
					map: 'Europe',
					finalScores: scores(60, 100),
					winner: 'Lonestar'
				},
				{ serverId: w.server.id, startedAt: ago(20 * MIN), map: 'Kavkazi' },
				{
					serverId: w.otherServer.id,
					startedAt: ago(1440 * MIN),
					endedAt: ago(1440 * MIN - 40 * MIN),
					map: 'Europe',
					finalScores: scores(100, 0),
					winner: 'Valkyra'
				},
				{
					serverId: w.otherOrgServer.id,
					startedAt: ago(1440 * MIN),
					endedAt: ago(1440 * MIN - 40 * MIN),
					map: 'Europe',
					finalScores: scores(100, 0),
					winner: 'Valkyra'
				}
			])
			.returning({ id: matches.id });
		const line = (
			matchId: number,
			serverId: string,
			p: typeof OWL,
			kills: number,
			deaths: number
		) => ({ matchId, serverId, steamId: p.id, name: p.name, faction: 'Valkyra', kills, deaths });
		await env.db.insert(matchPlayers).values([
			line(won.id, w.server.id, OWL, 20, 10),
			line(lost.id, w.server.id, OWL, 10, 10),
			// the match in progress counts on the board once it ends, not before
			line(onNow.id, w.server.id, OWL, 99, 0),
			line(other.id, w.otherServer.id, OWL, 1000, 1),
			line(theirs.id, w.otherOrgServer.id, OWL, 5000, 0),
			line(won.id, w.server.id, GUNNER, 21, 14),
			line(lost.id, w.server.id, GUNNER, 9, 6)
		]);
		const session = (
			serverId: string,
			p: typeof OWL,
			joined: number,
			minutes: number | null,
			seedSeconds = 0
		) => ({
			serverId,
			steamId: p.id,
			name: p.name,
			faction: 'Lonestar',
			joinedAt: ago(joined),
			lastSeen: ago(minutes === null ? 0 : joined - minutes * MIN),
			leftAt: minutes === null ? null : ago(joined - minutes * MIN),
			seedSeconds
		});
		await env.db.insert(playerSessions).values([
			session(w.server.id, OWL, 3 * 1440 * MIN, 120, 600),
			session(w.server.id, OWL, 2 * 1440 * MIN, 60),
			session(w.otherServer.id, OWL, 1440 * MIN, 500),
			session(w.otherOrgServer.id, OWL, 1440 * MIN, 900),
			// on now, beside a teammate: what a team kill needs
			session(w.server.id, GUNNER, 3 * 1440 * MIN, 600),
			session(w.server.id, GUNNER, MIN, null),
			session(w.server.id, MATE, MIN, null)
		]);
	});
	afterAll(() => releaseOwnership(env));

	test('the numbers are the server’s all-time board’s, and another server’s are not in them', async () => {
		const stats = await playerStats(env, [w.server.id], [OWL.id, NEW.id]);
		expect(stats.get(OWL.id)).toEqual({
			kills: 30,
			deaths: 20,
			minutes: 180,
			seedMinutes: 10,
			matches: 2,
			wins: 1,
			losses: 1,
			draws: 0
		});
		expect(stats.has(NEW.id)).toBe(false);
		const board = await loadBoard(
			env,
			[w.server.id],
			{
				scope: 'server',
				range: 'all',
				sort: 'kills',
				dir: 'desc',
				page: 1,
				minMinutes: 0
			},
			w.org.id
		);
		const row = board.rows.find((r) => r.steamId === OWL.id)!;
		const owl = stats.get(OWL.id)!;
		expect([row.kills, row.deaths, row.minutes, row.seedMinutes, row.matches, row.wins]).toEqual([
			owl.kills,
			owl.deaths,
			Math.round(owl.minutes),
			Math.round(owl.seedMinutes),
			owl.matches,
			owl.wins
		]);
	});

	test('across the organisation: every server of it, as its board counts them, never another organisation’s', async () => {
		const org = (await statsReader(env, w.server.id)('org', [OWL.id])).get(OWL.id)!;
		expect(org).toEqual({
			kills: 1030,
			deaths: 21,
			minutes: 680,
			seedMinutes: 10,
			matches: 3,
			wins: 2,
			losses: 1,
			draws: 0
		});
		const board = await loadBoard(
			env,
			[w.server.id, w.otherServer.id],
			{
				scope: 'org',
				range: 'all',
				sort: 'kills',
				dir: 'desc',
				page: 1,
				minMinutes: 0
			},
			w.org.id
		);
		const row = board.rows.find((r) => r.steamId === OWL.id)!;
		expect([row.kills, row.deaths, row.minutes, row.matches, row.wins]).toEqual([
			org.kills,
			org.deaths,
			Math.round(org.minutes),
			org.matches,
			org.wins
		]);
	});

	test('one evaluation reads each player once, and a failed read costs only the players not read yet', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const e = { ...env };
			const read = statsReader(e, w.server.id);
			const first = await read('here', [OWL.id, NEW.id, OWL.id]);
			expect(first.get(OWL.id)?.kills).toBe(30);
			expect(first.get(NEW.id)).toEqual(NO_STATS);
			// from here any query fails: players already read are answered without one
			e.db = new Proxy({} as Env['db'], {
				get() {
					throw new Error('the database is gone');
				}
			});
			expect((await read('here', [OWL.id])).get(OWL.id)?.kills).toBe(30);
			expect(warn).not.toHaveBeenCalled();
			const after = await read('here', [OWL.id, GUNNER.id]);
			expect(after.get(OWL.id)?.kills).toBe(30);
			expect(after.has(GUNNER.id)).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	const welcome = (message: string) =>
		({
			id: `welcome-${randomUUID()}`,
			name: 'Welcome whisper',
			kind: 'welcome',
			config: validateConfig('welcome', { message }),
			state: null,
			lastFiredAt: null
		}) as unknown as TriggerRow;
	/** a look at which these players joined */
	const joining = (joined: Player[]) =>
		({
			server: { id: w.server.id, name: 'Test' },
			status: { serverName: 'Test', map: 'Kavkazi', playerCount: 2, maxPlayers: 100, scores: [] },
			players: joined,
			joined,
			factioned: [],
			firstVisit: new Set(),
			ts: new Date()
		}) as unknown as TickContext;

	test('a welcome tells each joiner their own stats here; a newcomer has none yet', async () => {
		const row = welcome(
			'{player}: {kills} kills, {deaths} deaths, K/D {KDR}, {playtime}, {matches} matches, {wins} won ({winrate}), seeded {seeded}'
		);
		const ev = await evaluateTriggers(env, joining([player(OWL), player(NEW)]), [row]);
		expect(ev.intents.map((i) => i.params.message)).toEqual([
			'[ABC] Night Owl: 30 kills, 20 deaths, K/D 1.50, 3.0 h, 2 matches, 1 won (50%), seeded 10 min',
			'Newcomer: 0 kills, 0 deaths, K/D 0.00, 0 min, 0 matches, 0 won (0%), seeded 0 min'
		]);
	});

	test('two rules telling the same joiners their stats read them once', async () => {
		let reads = 0;
		const counted = {
			...env,
			db: new Proxy(env.db, {
				get(target, prop, receiver) {
					const v = Reflect.get(target, prop, receiver);
					if (prop !== 'execute') return v;
					return (...args: unknown[]) => {
						reads++;
						return (v as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
			})
		};
		const ev = await evaluateTriggers(counted, joining([player(OWL)]), [
			welcome('{player}: {kills} kills'),
			welcome('K/D {kd} over {matches} matches'),
			welcome('{org_kills} on all our servers, K/D {org_kdr}'),
			welcome('{org_matches} matches in all'),
			welcome('Welcome {player}')
		]);
		expect(ev.intents.map((i) => i.params.message)).toEqual([
			'[ABC] Night Owl: 30 kills',
			'K/D 1.50 over 2 matches',
			'1030 on all our servers, K/D 49.05',
			'3 matches in all',
			'Welcome [ABC] Night Owl'
		]);
		// this server's stats, the organisation's servers, the organisation's stats: once each
		expect(reads).toBe(3);
	});

	test('a Scheduled broadcast’s dry run fills its messages from what each sample held', async () => {
		await env.db.insert(samples).values({
			ts: ago(30 * MIN),
			serverId: w.server.id,
			ok: true,
			playerCount: 12,
			maxPlayers: 100,
			map: 'Kavkazi'
		});
		const r = await dryRun(
			env,
			{ id: w.server.id, name: 'Test', orgId: w.org.id } as never,
			'broadcast',
			{ messages: ['{players} of {max} on {map}, {name} {kills}'], everyMinutes: 5 }
		);
		expect(r.items.map((i) => i.text)).toContain('broadcast (12 on): 12 of 100 on Bakurani,  ');
	});

	test('a dry run shows where the stats go, not what they were then', async () => {
		const r = await dryRun(
			env,
			{ id: w.server.id, name: 'Test', orgId: w.org.id } as never,
			'welcome',
			{
				message: '{player} has {kills} kills ({org_kills} in all) on {map}'
			}
		);
		expect(r.items.map((i) => i.text)).toContain(
			'whisper Gunner: Gunner has … kills (… in all) on …'
		);
	});

	test('a team kill whisper says who did it, their stats here, and the map the kill was on', async () => {
		const rule = newId();
		await env.db.insert(triggers).values({
			id: rule,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'team_kill',
			name: 'Team kill limit',
			enabled: true,
			config: validateConfig('team_kill', {
				warnAt: 1,
				warnMessage: '{name} ({faction}) has {kills} kills here, K/D {kd}; {victim} on {map}',
				kickAt: 0
			})
		});
		invalidateTriggers(w.server.id);
		const got = await ingestBatch(env, w.server.id, {
			serverId: randomUUID(),
			serverName: 'Test',
			events: [
				{
					eventId: randomUUID(),
					type: 'killed',
					eventTime: 100,
					matchId: randomUUID(),
					mapName: 'Kavkazi',
					killerName: GUNNER.name,
					killerSteamId: GUNNER.id,
					victimName: MATE.name,
					victimSteamId: MATE.id,
					cause: 'Id.Item.AK74M',
					distance: 3000,
					contextTags: []
				}
			]
		});
		expect(got.kills.map((k) => k.teamKill)).toEqual([true]);
		await onKillsIngested(env, w.server.id, got.kills);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerId, rule), eq(outbox.steamId, GUNNER.id)));
		expect(rows.map((r) => [r.action, (r.params as { message: string }).message])).toEqual([
			['whisper', 'Gunner (Lonestar) has 30 kills here, K/D 1.50; Mate on Bakurani']
		]);
	});

	test('a Kill distance kick reason says who, their stats here (not the org’s), the kill and its map', async () => {
		const rule = newId();
		const config = validateConfig('kill_distance', {
			causes: ['Id.Item.Defibrillator.Standard'],
			minDistanceM: 100,
			count: 1,
			action: 'kick',
			// a ban's reason is kept where staff read it, so no org-wide stats, kick or ban
			reason:
				'{name} ({faction}, {kills} kills here, {org_kills}): {weapon} from {distance} m on {map}'
		});
		await env.db.insert(triggers).values({
			id: rule,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'kill_distance',
			name: 'Kill distance watch',
			enabled: true,
			config
		});
		invalidateTriggers(w.server.id);
		const got = await ingestBatch(env, w.server.id, {
			serverId: randomUUID(),
			serverName: 'Test',
			events: [
				{
					eventId: randomUUID(),
					type: 'killed',
					eventTime: 200,
					matchId: randomUUID(),
					mapName: 'Europe',
					killerName: GUNNER.name,
					killerSteamId: GUNNER.id,
					victimName: NEW.name,
					victimSteamId: NEW.id,
					cause: 'Id.Item.Defibrillator.Standard',
					distance: 40_000,
					contextTags: []
				}
			]
		});
		await onKillsIngested(env, w.server.id, got.kills);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerId, rule), eq(outbox.steamId, GUNNER.id)));
		expect(rows.map((r) => [r.action, (r.params as { reason: string }).reason])).toEqual([
			['kick', 'Gunner (Lonestar, 30 kills here, {org_kills}): Defibrillator from 400 m on Ozeti']
		]);
	});
});
