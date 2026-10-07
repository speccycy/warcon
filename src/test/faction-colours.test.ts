// A status the game sent with a hostile faction colour, or a score that is not a number, stored
// before either was checked (or while its server is down, so no newer look replaces it): the
// reads that hand it to pages check it again, and the boards read such a score as no score.
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { matches, matchPlayers, playerSessions, serverLive } from '$lib/server/db/schema';
import { liveViewFromRow } from '$lib/server/live';
import { liveFactions } from '$lib/server/matches';
import { loadBoard } from '$lib/server/leaderboards';
import { DEFAULT_BOARD_QUERY } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const HOSTILE = 'red;background:url(https://evil.example/beacon?v=1);position:fixed;inset:0';
const PLAYER = '76561198000000611';

describe.skipIf(!hasTestDb)('faction colours and scores from the game', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		await env.db.insert(serverLive).values({
			serverId: w.server.id,
			ok: true,
			status: {
				map: 'Ozeti',
				playerCount: 1,
				maxPlayers: 64,
				experiences: [],
				scores: [
					{ name: 'Valkyra', colorHex: '#D86060', score: 30 },
					{ name: 'Lonestar', colorHex: HOSTILE, score: 'abc' }
				]
			}
		});
		const at = (h: number) => new Date(Date.now() - h * 3_600_000);
		const [m] = await env.db
			.insert(matches)
			.values({
				serverId: w.server.id,
				startedAt: at(3),
				endedAt: at(2),
				map: 'Ozeti',
				finalScores: [
					{ name: 'Valkyra', score: 'abc' },
					{ name: 'Lonestar', score: 'n/a' }
				],
				winner: null
			})
			.returning({ id: matches.id });
		await env.db.insert(matchPlayers).values({
			matchId: m.id,
			serverId: w.server.id,
			steamId: PLAYER,
			name: 'Scored',
			faction: 'Valkyra',
			seconds: 3000,
			kills: 5,
			deaths: 2
		});
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: PLAYER,
			name: 'Scored',
			joinedAt: at(3),
			lastSeen: at(2),
			leftAt: at(2)
		});
	});

	test('a stored status reaches pages with its hostile colour dropped', async () => {
		const [row] = await env.db
			.select()
			.from(serverLive)
			.where(eq(serverLive.serverId, w.server.id));
		const view = liveViewFromRow(row);
		expect(view.status?.scores).toEqual([
			{ name: 'Valkyra', colorHex: '#D86060', score: 30 },
			{ name: 'Lonestar', colorHex: '', score: 0 }
		]);
		expect(await liveFactions(env, w.server.id)).toEqual([
			{ name: 'Valkyra', colorHex: '#D86060', score: 30 },
			{ name: 'Lonestar', colorHex: null, score: 0 }
		]);
	});

	test('the boards read a score that is not a number as no score, not as an error', async () => {
		const board = await loadBoard(
			env,
			[w.server.id],
			{ ...DEFAULT_BOARD_QUERY, range: '30d', minMinutes: 0 },
			w.org.id
		);
		const row = board.rows.find((r) => r.steamId === PLAYER);
		expect([row?.matches, row?.wins, row?.losses, row?.draws]).toEqual([1, 0, 0, 0]);
	});
});
