// The columns an organisation's public boards leave out: who may change them (an owner of the
// org, never a key), what a change must hold, the audit row, and what each board does with them:
// the public page leaves them out and ranks by kills where it was asked to sort by one, while the
// public JSON, the panel's board and its export keep every number. Another organisation's boards
// are never touched.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, playerSessions, servers } from '$lib/server/db/schema';
import type { BoardColumn, BoardView } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, callRaw, stubGateway } from './call';
import { seedWorld, suspend, type PrincipalName, type World } from './world';
import { PATCH as orgRoute } from '../routes/api/orgs/[id]/+server';
import { GET as seasonsRoute } from '../routes/api/orgs/[id]/seasons/+server';
import { load as seasonsTab } from '../routes/(app)/orgs/[id]/seasons/+page.server';
import { load as publicPage } from '../routes/(public)/s/[id]/leaderboard/+page.server';
import { GET as publicJson } from '../routes/api/public/servers/[id]/leaderboard/+server';
import { GET as panelBoard } from '../routes/api/servers/[id]/leaderboard/+server';
import { GET as exportRoute } from '../routes/api/servers/[id]/leaderboard/export/+server';

const HIDDEN: BoardColumn[] = ['seeded', 'headshots', 'teamKills', 'results', 'cash'];
const PLAYER = '76561198000005001';

describe.skipIf(!hasTestDb)("an organisation's public board columns", () => {
	let env: Env;
	let w: World;

	const patch = (who: PrincipalName, boardHidden: unknown, orgId = w.org.id) =>
		callApi(orgRoute, w.users[who], {
			method: 'PATCH',
			params: { id: orgId },
			body: { boardHidden }
		});
	const stored = async (orgId = w.org.id) =>
		(
			await env.db
				.select({ hidden: organizations.boardHidden })
				.from(organizations)
				.where(eq(organizations.id, orgId))
		)[0].hidden;
	// the last 30 days: the history here is two hours old, so the default (the current season)
	// would leave it out on a season's first two hours
	const RANGE = 'range=30d';
	/** the public page as an anonymous visitor gets it */
	const page = async (query = '', serverId = w.server.id) => {
		const answer = await callLoad(publicPage, null, {
			params: { id: serverId },
			query: query ? `${RANGE}&${query}` : RANGE
		});
		expect(answer.status).toBe(200);
		return answer.body as { hidden: BoardColumn[]; board: BoardView };
	};
	const open = (serverId: string, on: boolean) =>
		env.db.update(servers).set({ publicLeaderboards: on }).where(eq(servers.id, serverId));

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		await open(w.server.id, true);
		await open(w.otherOrgServer.id, true);
		// one player with an hour and a half and some cash, so every board has a row
		const joined = Date.now() - 2 * 3_600_000;
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: PLAYER,
			name: 'Cashed',
			joinedAt: new Date(joined),
			lastSeen: new Date(joined + 90 * 60_000),
			leftAt: new Date(joined + 90 * 60_000),
			cash: 9_000
		});
	});

	afterAll(async () => {
		await open(w.server.id, false);
		await open(w.otherOrgServer.id, false);
	});

	test('every column shows until an owner leaves some out', async () => {
		expect(await stored()).toEqual([]);
		expect((await page()).hidden).toEqual([]);
	});

	test('only an owner of the org changes them, and never through a key', async () => {
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'viewer',
			'operator',
			'admin',
			'elsewhere',
			'orgBans',
			'orgSlots',
			'keyView',
			'keyAll',
			'keyElsewhere',
			'keyBans'
		] as PrincipalName[]) {
			const answer = await patch(who, HIDDEN);
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
			expect(await stored()).toEqual([]);
		}
		// an owner of one org cannot reach another's
		expect((await patch('owner', HIDDEN, w.otherOrg.id)).status).toBe(404);
		expect(await stored(w.otherOrg.id)).toEqual([]);

		expect((await patch('owner', HIDDEN)).status).toBe(200);
		expect(await stored()).toEqual(HIDDEN);
	});

	test('the change is in the audit trail with the columns it left out', async () => {
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.update')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row).toMatchObject({ actorId: w.users.owner!.id, outcome: 'ok' });
		expect((row.detail as { boardHidden: BoardColumn[] }).boardHidden).toEqual(HIDDEN);
	});

	test('anything but the board’s own columns is refused and changes nothing', async () => {
		for (const bad of [
			'cash',
			['kills'],
			['seeded', 'kills'],
			['luck'],
			[1],
			null,
			{ cash: true }
		]) {
			const answer = await patch('owner', bad);
			expect({ bad, status: answer.status }).toEqual({ bad, status: 400 });
			expect(await stored()).toEqual(HIDDEN);
		}
	});

	test('the public page leaves them out at once, and a sort by one ranks by kills', async () => {
		const asked = await page('sort=cash&dir=asc');
		expect(asked.hidden).toEqual(HIDDEN);
		expect(asked.board.query).toMatchObject({ sort: 'kills', dir: 'desc' });
		expect(asked.board.rows.map((r) => r.steamId)).toEqual([PLAYER]);
		expect((await page('sort=wins')).board.query.sort).toBe('kills');
		expect((await page('sort=seeded')).board.query.sort).toBe('kills');
		// a column still shown keeps its sort
		expect((await page('sort=cashPerMin&dir=asc')).board.query).toMatchObject({
			sort: 'cashPerMin',
			dir: 'asc'
		});
	});

	test('the public JSON, the panel and the export keep every number and every sort', async () => {
		const json = await callApi(publicJson, null, {
			params: { id: w.server.id },
			query: `${RANGE}&sort=cash`
		});
		expect(json.status).toBe(200);
		const view = json.body as BoardView;
		expect(view.query.sort).toBe('cash');
		expect(view.rows[0]).toMatchObject({ steamId: PLAYER, cash: 9_000 });
		expect(json.body).not.toHaveProperty('hidden');

		const panel = await callApi(panelBoard, w.users.viewer, {
			params: { id: w.server.id },
			query: `${RANGE}&sort=cash`
		});
		expect((panel.body as BoardView).query.sort).toBe('cash');
		expect((panel.body as BoardView).rows[0].cash).toBe(9_000);

		const file = await callRaw(exportRoute, w.users.viewer, {
			params: { id: w.server.id },
			query: `${RANGE}&sort=cash`
		});
		const [head, first] = (await file.text()).split('\r\n');
		expect(head.split(',')).toContain('cash');
		expect(first.split(',')[head.split(',').indexOf('cash')]).toBe('9000');
	});

	test("the Seasons tab and its route show them to the org's owners", async () => {
		const tab = await callLoad(seasonsTab, w.users.owner, { params: { id: w.org.id } });
		expect((tab.body as { hidden: BoardColumn[] }).hidden).toEqual(HIDDEN);
		const listed = await callApi(seasonsRoute, w.users.owner, { params: { id: w.org.id } });
		expect((listed.body as { hidden: BoardColumn[] }).hidden).toEqual(HIDDEN);
		for (const who of ['viewer', 'admin', 'keyAll'] as PrincipalName[]) {
			const refused = await callLoad(seasonsTab, w.users[who], { params: { id: w.org.id } });
			expect({ who, refused: refused.status >= 400 }).toEqual({ who, refused: true });
		}
	});

	test("another organisation's public board keeps every column", async () => {
		const theirs = await page('sort=cash', w.otherOrgServer.id);
		expect(theirs.hidden).toEqual([]);
		expect(theirs.board.query.sort).toBe('cash');
	});

	test('repeats are dropped, the order is the table’s, and none shows every column again', async () => {
		expect((await patch('owner', ['cash', 'seeded', 'cash'])).status).toBe(200);
		expect(await stored()).toEqual(['seeded', 'cash']);
		expect((await patch('owner', [])).status).toBe(200);
		expect(await stored()).toEqual([]);
		expect((await page()).hidden).toEqual([]);
	});

	test("a suspended org's owners cannot change them", async () => {
		await suspend(env, w.org.id);
		try {
			expect((await patch('owner', HIDDEN)).status).toBe(403);
			expect(await stored()).toEqual([]);
		} finally {
			await env.db
				.update(organizations)
				.set({ suspendedAt: null, suspendedReason: '' })
				.where(eq(organizations.id, w.org.id));
		}
	});
});
