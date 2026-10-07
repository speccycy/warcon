// Export CSV on the Leaderboards tab: the whole board as it is set, not the page on screen, with
// names written so a spreadsheet does not run them, and the organisation scope held to the
// servers the caller can open, as the board's own is.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { playerSessions, seasons } from '$lib/server/db/schema';
import { BOARD_PAGE } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { callRaw, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import { GET as exportRoute } from '../routes/api/servers/[id]/leaderboard/export/+server';

const PLAYERS = BOARD_PAGE + 5;
const FORMULA = '=HYPERLINK("http://evil.example","x")';
const ELSEWHERE = '76561198000000999';
/** the cash two players made: the first more per minute, the second more in all */
const CASH: Record<number, number> = { 0: 6_100, 39: 8_000 };

describe.skipIf(!hasTestDb)('leaderboard export', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		const hour = 3_600_000;
		const session = (
			serverId: string,
			steamId: string,
			name: string,
			minutes: number,
			cash = 0
		) => ({
			serverId,
			steamId,
			name,
			joinedAt: new Date(Date.now() - 2 * hour),
			lastSeen: new Date(Date.now() - 2 * hour + minutes * 60_000),
			leftAt: new Date(Date.now() - 2 * hour + minutes * 60_000),
			cash
		});
		await env.db
			.insert(playerSessions)
			.values([
				...Array.from({ length: PLAYERS - 1 }, (_, i) =>
					session(
						w.server.id,
						`7656119800000${String(1000 + i)}`,
						`Player ${i + 1}`,
						61 + i,
						CASH[i]
					)
				),
				session(w.server.id, '76561198000002000', FORMULA, 30),
				session(w.otherServer.id, ELSEWHERE, 'Elsewhere Only', 110)
			]);
	});

	// the last 30 days unless the query names a range: the history here is two hours old, so the
	// default (the current season) would leave it out on a season's first two hours
	const download = async (who: PrincipalName, query: string, serverId = w.server.id) => {
		const res = await callRaw(exportRoute, w.users[who], {
			params: { id: serverId },
			query: query.includes('range=') ? query : `${query}&range=30d`
		});
		return { res, lines: (await res.text()).split('\r\n') };
	};

	test('every row of the board, ranked, under a header', async () => {
		const { res, lines } = await download('owner', 'minMinutes=0&sort=playtime');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(
			/^attachment; filename="[a-z0-9-]+-leaderboard-30d-\d{4}-\d{2}-\d{2}\.csv"$/
		);
		expect(lines[0].split(',')).toEqual([
			'rank',
			'steam_id',
			'name',
			'playtime_min',
			'seeded_min',
			'kills',
			'deaths',
			'kd',
			'kills_per_hour',
			'headshots',
			'team_kills',
			'suicides',
			'vehicle_kills',
			'kill_streak',
			'death_streak',
			'matches',
			'wins',
			'losses',
			'draws',
			'win_pct',
			'cash',
			'cash_per_min',
			'last_seen'
		]);
		// more than one page of the board, in the order it ranks them
		expect(lines.length - 1).toBe(PLAYERS);
		expect(lines[1].startsWith(`1,7656119800000${1000 + PLAYERS - 2},Player ${PLAYERS - 1},`)).toBe(
			true
		);
		expect(lines.map((l) => l.split(',')[0]).slice(1, 4)).toEqual(['1', '2', '3']);
	});

	test('cash per minute is cash over playtime, and the board ranks by it', async () => {
		const column = (lines: string[], name: string) => {
			const at = lines[0].split(',').indexOf(name);
			return lines.slice(1, 3).map((l) => l.split(',')[at]);
		};
		// $6,100 over 61 minutes, then $8,000 over 100
		const rate = (await download('owner', 'minMinutes=0&sort=cashPerMin')).lines;
		expect(column(rate, 'steam_id')).toEqual(['76561198000001000', '76561198000001039']);
		expect(column(rate, 'cash_per_min')).toEqual(['100', '80']);
		const cash = (await download('owner', 'minMinutes=0&sort=cash')).lines;
		expect(column(cash, 'steam_id')).toEqual(['76561198000001039', '76561198000001000']);
	});

	test('a name that a spreadsheet would run is written as text', async () => {
		const { lines } = await download('owner', 'minMinutes=0');
		const row = lines.find((l) => l.includes('HYPERLINK'));
		expect(row).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
	});

	test('the playtime floor and the page are the board’s, the page ignored', async () => {
		const { lines } = await download('owner', 'minMinutes=60&page=2');
		expect(lines.length - 1).toBe(PLAYERS - 1);
		expect(lines.some((l) => l.includes('HYPERLINK'))).toBe(false);
	});

	test('the organisation scope covers only the servers the caller can open', async () => {
		const owner = await download('owner', 'scope=org&minMinutes=0');
		expect(owner.lines.some((l) => l.includes(ELSEWHERE))).toBe(true);
		const viewer = await download('viewer', 'scope=org&minMinutes=0');
		expect(viewer.res.status).toBe(200);
		expect(viewer.lines.length - 1).toBe(PLAYERS);
		expect(viewer.lines.some((l) => l.includes(ELSEWHERE))).toBe(false);
	});

	test('a key held to one server exports that server alone, whatever the scope', async () => {
		const refused = await download('keyElsewhere', 'scope=org&minMinutes=0');
		expect(refused.res.status).toBe(404);
		const own = await download('keyElsewhere', 'scope=org&minMinutes=0', w.otherServer.id);
		expect(own.res.status).toBe(200);
		expect(own.lines.slice(1).map((l) => l.split(',')[1])).toEqual([ELSEWHERE]);
	});
});

describe.skipIf(!hasTestDb)('cash per minute at the edges of a range or a season', () => {
	const H = 3_600_000;
	const STRADDLER = '76561198000003001';
	const STEADY = '76561198000003002';
	const columns = async (w: World, user: PrincipalName, query: string) => {
		const res = await callRaw(exportRoute, w.users[user], { params: { id: w.server.id }, query });
		const [head, ...rows] = (await res.text()).split('\r\n');
		const at = (name: string) => head.split(',').indexOf(name);
		return (name: string) => rows.map((r) => r.split(',')[at(name)]);
	};
	const session = (
		w: World,
		steamId: string,
		name: string,
		joined: number,
		left: number,
		cash: number
	) => ({
		serverId: w.server.id,
		steamId,
		name,
		joinedAt: new Date(joined),
		lastSeen: new Date(left),
		leftAt: new Date(left),
		cash
	});

	test('a session that began before the range counts all of its time, as it does all of its cash', async () => {
		const env = await testEnv();
		stubGateway();
		const w = await seedWorld(env);
		const start = Date.now() - 7 * 24 * H;
		await env.db.insert(playerSessions).values([
			// four hours at $100 a minute, the last two inside the seven days
			session(w, STRADDLER, 'Straddler', start - 2 * H, start + 2 * H, 24_000),
			// two hours at $120 a minute, well inside
			session(w, STEADY, 'Steady', start + 5 * 24 * H, start + 5 * 24 * H + 2 * H, 14_400)
		]);
		const col = await columns(w, 'owner', 'range=7d&sort=cashPerMin&minMinutes=60');
		expect(col('name')).toEqual(['Steady', 'Straddler']);
		expect(col('cash_per_min')).toEqual(['120', '100']);
		// the playtime is still what was played inside the range
		expect(col('playtime_min')).toEqual(['120', '120']);
	});

	test('a session still going when a season ended gives it no cash and none of its time; the next season gets both', async () => {
		const env = await testEnv();
		stubGateway();
		const w = await seedWorld(env);
		const now = Date.now();
		const turn = now - 24 * H;
		const [before, after] = [`before-${now}`, `after-${now}`];
		await env.db.insert(seasons).values([
			{ id: before, orgId: w.org.id, name: 'Before', startsAt: new Date(turn - 10 * 24 * H) },
			{ id: after, orgId: w.org.id, name: 'After', startsAt: new Date(turn) }
		]);
		await env.db.insert(playerSessions).values([
			// four hours at $100 a minute across the turn of the season
			session(w, STRADDLER, 'Straddler', turn - 2 * H, turn + 2 * H, 24_000),
			// two hours at $120 a minute before it
			session(w, STEADY, 'Steady', turn - 5 * H, turn - 3 * H, 14_400)
		]);
		const ended = await columns(w, 'owner', `range=s:${before}&sort=cashPerMin&minMinutes=60`);
		expect(ended('name')).toEqual(['Steady', 'Straddler']);
		expect(ended('cash')).toEqual(['14400', '0']);
		expect(ended('cash_per_min')).toEqual(['120', '']);
		const next = await columns(w, 'owner', `range=s:${after}&sort=cashPerMin&minMinutes=60`);
		expect(next('name')).toEqual(['Straddler']);
		expect(next('cash_per_min')).toEqual(['100']);
	});
});
