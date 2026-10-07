// A page of a board is kept for a minute per (servers, query): a second look inside the minute is
// not read again, requests that arrive during a read share it, a failed read is not kept, a purge
// forgets it, and nobody is handed a board over servers other than the ones their own check gave
// them (an organisation board read by its owner first, then asked for by a member given one of
// its servers, or by anyone on the public board).
import { afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, playerSessions, servers } from '$lib/server/db/schema';
import { forgetBoards, loadBoard } from '$lib/server/leaderboards';
import { parseBoardQuery } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET as panelBoard } from '../routes/api/servers/[id]/leaderboard/+server';
import { GET as publicBoard } from '../routes/api/public/servers/[id]/leaderboard/+server';
import { POST as purge } from '../routes/api/servers/[id]/stats/purge/+server';

const HOUR = 3_600_000;
const HERE = '76561198000000301';
const THERE = '76561198000000302';
const LATER = '76561198000000303';
const q = parseBoardQuery(new URLSearchParams('minMinutes=0&range=30d'));

describe.skipIf(!hasTestDb)('board cache', () => {
	let env: Env;
	let w: World;

	const played = (serverId: string, steamId: string) =>
		env.db.insert(playerSessions).values({
			serverId,
			steamId,
			name: steamId.slice(-3),
			joinedAt: new Date(Date.now() - 2 * HOUR),
			lastSeen: new Date(Date.now() - HOUR),
			leftAt: new Date(Date.now() - HOUR)
		});
	const ids = (view: { rows: { steamId: string }[] }) => view.rows.map((r) => r.steamId).sort();
	/** The env with its raw statements counted (the board's aggregate is one), or failing. */
	const counted = (fail = false) => {
		const n = { execute: 0 };
		const db = new Proxy(env.db, {
			get(target, prop, receiver) {
				if (prop !== 'execute') return Reflect.get(target, prop, receiver);
				return (...args: unknown[]) => {
					n.execute++;
					if (fail) return Promise.reject(new Error('down'));
					return (target.execute as (...a: unknown[]) => unknown)(...args);
				};
			}
		});
		return { env: { ...env, db } as Env, n };
	};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		await played(w.server.id, HERE);
		await played(w.otherServer.id, THERE);
	});

	afterEach(() => {
		setSystemTime();
		forgetBoards();
	});

	test('a second look inside the minute is the first one; after it, the board is read again', async () => {
		const first = await loadBoard(env, [w.server.id], q, w.org.id);
		expect(ids(first)).toEqual([HERE]);
		await played(w.server.id, LATER);
		expect(ids(await loadBoard(env, [w.server.id], q, w.org.id))).toEqual([HERE]);
		setSystemTime(new Date(Date.now() + 61_000));
		expect(ids(await loadBoard(env, [w.server.id], q, w.org.id))).toEqual([HERE, LATER]);
		await env.db.delete(playerSessions).where(eq(playerSessions.steamId, LATER));
	});

	test('the requests that arrive during a read wait for it; a failed read is not kept', async () => {
		const down = counted(true);
		await expect(loadBoard(down.env, [w.server.id], q, w.org.id)).rejects.toThrow('down');
		const up = counted();
		const [a, b] = await Promise.all([
			loadBoard(up.env, [w.server.id], q, w.org.id),
			loadBoard(up.env, [w.server.id], q, w.org.id)
		]);
		expect(up.n.execute).toBe(1);
		expect(ids(a)).toEqual([HERE]);
		expect(b).toEqual(a);
	});

	test('every part of the query is its own board, and so is every set of servers', async () => {
		const up = counted();
		await loadBoard(up.env, [w.server.id, w.otherServer.id], q, w.org.id);
		// the same servers in another order are the same board
		await loadBoard(up.env, [w.otherServer.id, w.server.id], q, w.org.id);
		expect(up.n.execute).toBe(1);
		await loadBoard(up.env, [w.server.id], q, w.org.id);
		await loadBoard(up.env, [w.server.id, w.otherServer.id], { ...q, page: 2 }, w.org.id);
		await loadBoard(up.env, [w.server.id, w.otherServer.id], { ...q, sort: 'deaths' }, w.org.id);
		await loadBoard(up.env, [w.server.id, w.otherServer.id], { ...q, minMinutes: 1 }, w.org.id);
		await loadBoard(up.env, [w.server.id, w.otherServer.id], { ...q, range: 'all' }, w.org.id);
		await loadBoard(up.env, [w.server.id, w.otherServer.id], { ...q, dir: 'asc' }, w.org.id);
		const org = await loadBoard(
			up.env,
			[w.server.id, w.otherServer.id],
			{ ...q, scope: 'org' },
			w.org.id
		);
		expect(up.n.execute).toBe(8);
		expect(org.query.scope).toBe('org');
	});

	test("an organisation board read by its owner is not a member's who was given one server", async () => {
		const query = 'scope=org&minMinutes=0&range=30d';
		const owner = await callApi(panelBoard, w.users.owner, {
			params: { id: w.server.id },
			query
		});
		expect(owner.status).toBe(200);
		expect(ids(owner.body as { rows: { steamId: string }[] })).toEqual([HERE, THERE]);
		const member = await callApi(panelBoard, w.users.elsewhere, {
			params: { id: w.otherServer.id },
			query
		});
		expect(member.status).toBe(200);
		expect(ids(member.body as { rows: { steamId: string }[] })).toEqual([THERE]);
		const key = await callApi(panelBoard, w.users.keyElsewhere, {
			params: { id: w.otherServer.id },
			query
		});
		expect(ids(key.body as { rows: { steamId: string }[] })).toEqual([THERE]);
		// and a server the caller cannot open is still refused, board kept or not
		const outsider = await callApi(panelBoard, w.users.outsider, {
			params: { id: w.server.id },
			query
		});
		expect(outsider.status).toBe(404);
	});

	test('the public organisation board covers only the public servers, whatever was read before', async () => {
		await env.db
			.update(organizations)
			.set({ allowPublicLeaderboards: true })
			.where(eq(organizations.id, w.org.id));
		await env.db
			.update(servers)
			.set({ publicLeaderboards: true })
			.where(eq(servers.id, w.otherServer.id));
		const query = 'scope=org&minMinutes=0&range=30d';
		const owner = await callApi(panelBoard, w.users.owner, {
			params: { id: w.otherServer.id },
			query
		});
		expect(ids(owner.body as { rows: { steamId: string }[] })).toEqual([HERE, THERE]);
		const anon = await callApi(publicBoard, null, { params: { id: w.otherServer.id }, query });
		expect(anon.status).toBe(200);
		expect(ids(anon.body as { rows: { steamId: string }[] })).toEqual([THERE]);
		// the server whose board is not public answers nothing, kept board or not
		const closed = await callApi(publicBoard, null, { params: { id: w.server.id }, query });
		expect(closed.status).toBe(404);
		await env.db
			.update(servers)
			.set({ publicLeaderboards: false })
			.where(eq(servers.id, w.otherServer.id));
	});

	test("a purge forgets the server's boards at once", async () => {
		const [{ name }] = await env.db
			.select({ name: servers.name })
			.from(servers)
			.where(eq(servers.id, w.server.id));
		const before = await loadBoard(env, [w.server.id, w.otherServer.id], q, w.org.id);
		expect(ids(before)).toEqual([HERE, THERE]);
		await played(w.server.id, LATER);
		const done = await callApi(purge, w.users.owner, {
			method: 'POST',
			params: { id: w.server.id },
			body: { name }
		});
		expect(done.status).toBe(200);
		// sessions stay through a purge, so the board read again has the newcomer
		expect(ids(await loadBoard(env, [w.server.id, w.otherServer.id], q, w.org.id))).toEqual([
			HERE,
			THERE,
			LATER
		]);
		await env.db.delete(playerSessions).where(eq(playerSessions.steamId, LATER));
	});
});
