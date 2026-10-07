// Team balance against the panel: a move a person makes from the Players tab or the API is kept by
// the rule (noted where the worker runs it), while a move refused for want of the right, by the
// game, or never made notes nothing; and a rule set to watch only keeps its moves as rows that are
// never sent.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { outbox, triggers } from '$lib/server/db/schema';
import type { TriggerRow } from '$lib/server/db/schema';
import { setGateway } from '$lib/server/gateway';
import { localGateway, staffMoveOf } from '$lib/server/gateway-local';
import { enqueueIntents } from '$lib/server/outbox';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { evaluateTriggers, forgetRuleMemory, type TickContext } from '$lib/server/triggers';
import { validateTwoTeams } from '$lib/server/two-teams';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, type CallInput, type Outcome } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const V = 'Valkyra';
const M = 'Manticore';
/** the player moved onto the bigger side in every test */
const MOVED = '76561198000000700';
/** a player whose move the stand-in game refuses */
const REFUSED = '76561198000000701';

describe('staffMoveOf', () => {
	test('a changeTeam, or a raw PATCH of one player with a faction; nothing else', () => {
		const ok = { status: 200 };
		expect(staffMoveOf('changeTeam', { steamId: MOVED, faction: V }, {})).toEqual({
			steamId: MOVED,
			faction: V
		});
		const patch = { method: 'patch', path: `/v1/players/${MOVED}`, body: { faction: V } };
		expect(staffMoveOf('raw', patch, ok)).toEqual({ steamId: MOVED, faction: V });
		expect(
			staffMoveOf(
				'raw',
				{ method: 'PATCH', path: `/v1/players/${MOVED}`, body: JSON.stringify({ faction: V }) },
				ok
			)
		).toEqual({ steamId: MOVED, faction: V });
		// raw answers with the game's status instead of throwing: a refusal moved nobody
		for (const status of [404, 429, 500, undefined])
			expect(staffMoveOf('raw', patch, { status })).toBeNull();
		for (const [action, params] of [
			['changeTeam', { steamId: 'someone', faction: V }],
			['changeTeam', { steamId: MOVED }],
			['kick', { steamId: MOVED, faction: V }],
			['raw', { method: 'POST', path: `/v1/players/${MOVED}`, body: { faction: V } }],
			['raw', { method: 'PATCH', path: `/v1/players/${MOVED}/kill`, body: { faction: V } }],
			['raw', { method: 'PATCH', path: `/v1/players/${MOVED}`, body: 'not json' }]
		] as const)
			expect([action, staffMoveOf(action, params as Record<string, unknown>, ok)]).toEqual([
				action,
				null
			]);
	});
});

describe.skipIf(!hasTestDb)('Team balance against the panel', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	const requests: string[] = [];

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		// The worker's own gateway, in this process: an action runs as it would on the worker, against
		// a stand-in game that moves anyone but REFUSED.
		setGateway(localGateway);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (method: string, path: string) => {
						requests.push(`${method} ${path}`);
						if (method === 'PATCH' && path === `/v1/players/${REFUSED}`)
							throw new GameError(404, 'Player not found.', 'not_found');
						return { ok: true };
					},
					// raw hands back whatever the game answered, refusals included
					raw: async (method: string, path: string) => {
						requests.push(`${method} ${path}`);
						const refused = path === `/v1/players/${REFUSED}`;
						return { status: refused ? 404 : 200, text: '{}', headers: {} };
					}
				}) as unknown as WardogsClient
		);
	});

	afterEach(() => forgetRuleMemory());
	afterAll(() => spy?.mockRestore());

	async function api(
		who: PrincipalName,
		route: string,
		input: Omit<CallInput, 'method'> = {}
	): Promise<Outcome> {
		const [method, path] = route.split(' ');
		const mod = await import(join(ROUTES, path, '+server.ts'));
		return callApi(mod[method], w.users[who], { ...input, method });
	}
	const changeTeam = (who: PrincipalName, steamId = MOVED, serverId = w.server.id) =>
		api(who, 'POST api/servers/[id]/rcon/[action]', {
			params: { id: serverId, action: 'changeTeam' },
			body: { steamId, faction: V }
		});

	const rule = () =>
		({
			id: `team-balance-${w.server.id}`,
			kind: 'two_teams',
			name: 'Team balance',
			config: validateTwoTeams({ closedFaction: 'Lonestar', balance: true, gap: 3 }),
			state: null
		}) as unknown as TriggerRow;
	const player = (steamId: string, faction: string): Player => ({
		name: `P${steamId.slice(-3)}`,
		steamId,
		faction,
		kills: 0,
		deaths: 0,
		cash: 0,
		ping: null
	});
	/** 7 v 5, with MOVED and REFUSED on Manticore */
	const teams = (movedTo = M, refusedTo = M) => [
		...Array.from({ length: 7 }, (_, i) => player(`7656119800000080${i}`, V)),
		...Array.from({ length: 3 }, (_, i) => player(`7656119800000090${i}`, M)),
		player(MOVED, movedTo),
		player(REFUSED, refusedTo)
	];
	/** One look at this server now, its moves remembered as the worker remembers them. */
	const evaluate = async (r: TriggerRow, players: Player[]) => {
		const ctx = {
			server: { id: w.server.id, name: 'Server' },
			status: {
				serverName: 'Server',
				map: 'Map',
				playerCount: players.length,
				maxPlayers: 100,
				scores: ['Lonestar', V, M].map((name) => ({ name, colorHex: '', score: 0 }))
			},
			players,
			playersObserved: true,
			playersIntervalMs: 1000,
			ts: new Date()
		} as unknown as TickContext;
		const ev = await evaluateTriggers(env, ctx, [r]);
		for (const f of ev.afterCommit ?? []) f();
		return ev;
	};
	/** whom one look moves */
	const look = async (r: TriggerRow, players: Player[]) =>
		(await evaluate(r, players)).intents
			.filter((i) => i.action === 'changeTeam')
			.map((i) => i.target);

	test('a move refused for want of the right notes nothing: the switch is put back', async () => {
		const r = rule();
		expect(await look(r, teams())).toEqual([]);
		const refused: [PrincipalName, number][] = [
			['anon', 401],
			['stranger', 404],
			['outsider', 404],
			['viewer', 403],
			['keyView', 403],
			['keyElsewhere', 404]
		];
		for (const [who, status] of refused)
			expect([who, (await changeTeam(who)).status]).toEqual([who, status]);
		// a person allowed to move players, but on another server: a note there covers nobody here
		expect((await changeTeam('owner', MOVED, w.otherServer.id)).status).toBe(200);
		expect(await look(r, teams(V))).toEqual([MOVED]);
	});

	test('a player who keeps switching onto the bigger side is put back at every switch', async () => {
		const r = rule();
		expect(await look(r, teams())).toEqual([]);
		for (let i = 0; i < 5; i++) {
			// onto Valkyra, 8 v 4: put back
			expect(await look(r, teams(V))).toEqual([MOVED]);
			// and seen back on Manticore, where the move put them
			expect(await look(r, teams())).toEqual([]);
		}
	});

	test('a move from the Players tab or the API is kept; one the game refused is not', async () => {
		const r = rule();
		expect(await look(r, teams())).toEqual([]);
		requests.length = 0;
		expect((await changeTeam('admin')).status).toBe(200);
		expect(requests).toEqual([`PATCH /v1/players/${MOVED}`, `POST /v1/players/${MOVED}/kill`]);
		expect((await changeTeam('keyAll', REFUSED)).status).toBe(404);
		// both now on Valkyra (9 v 3): the one the panel moved stays, the other is put back
		expect(await look(r, teams(V, V))).toEqual([REFUSED]);
	});

	test('a raw PATCH of a player is noted like a move, unless the game refused it', async () => {
		const r = rule();
		expect(await look(r, teams())).toEqual([]);
		const raw = (steamId: string) =>
			api('owner', 'POST api/servers/[id]/rcon/[action]', {
				params: { id: w.server.id, action: 'raw' },
				body: { method: 'PATCH', path: `/v1/players/${steamId}`, body: { faction: V } }
			});
		expect((await raw(MOVED)).status).toBe(200);
		// the panel's call succeeded; the game's answer inside it was a 404
		const refused = await raw(REFUSED);
		expect([
			refused.status,
			(refused.body as { result: { status: number } }).result.status
		]).toEqual([200, 404]);
		expect(await look(r, teams(V, V))).toEqual([REFUSED]);
	});

	test('watch only keeps each move as a row that is never sent', async () => {
		const watching = {
			...rule(),
			config: validateTwoTeams({ closedFaction: 'Lonestar', balance: true, watchOnly: true })
		} as TriggerRow;
		// 8 v 5: one more on Valkyra would be four ahead
		const seen = [...teams(), player('76561198000000998', V)];
		await look(watching, seen);
		const ev = await evaluate(watching, [...seen, player('76561198000000999', V)]);
		expect(ev.intents.map((i) => i.target)).toEqual(['76561198000000999']);
		expect(await enqueueIntents(env.db, w.server.id, ev.intents)).toBe(1);
		const [row] = await env.db
			.select()
			.from(outbox)
			.where(eq(outbox.dedupeKey, ev.intents[0].dedupeKey));
		expect(row.state).toBe('skipped');
		expect(row.outcome).toBe('Watch only: would move P999 to Manticore.');
		expect(row.doneAt).not.toBeNull();
	});
	test('switching a rule on again writes the marker its memory starts over on; a rename does not', async () => {
		const made = await api('owner', 'POST api/servers/[id]/triggers', {
			params: { id: w.otherServer.id },
			body: { kind: 'two_teams', config: { balance: true }, enabled: true }
		});
		expect(made.status).toBe(201);
		const triggerId = (made.body as { trigger: { id: string } }).trigger.id;
		const patch = (body: Record<string, unknown>) =>
			api('owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { id: w.otherServer.id, triggerId },
				body
			});
		const stateOf = async () =>
			(await env.db.select().from(triggers).where(eq(triggers.id, triggerId)))[0].state as {
				enabledAt?: number;
			} | null;
		expect(await stateOf()).toBeNull();
		expect((await patch({ enabled: false })).status).toBe(200);
		expect(await stateOf()).toBeNull();
		expect((await patch({ enabled: true })).status).toBe(200);
		const marker = (await stateOf())?.enabledAt;
		expect(typeof marker).toBe('number');
		expect((await patch({ name: 'Renamed' })).status).toBe(200);
		expect((await stateOf())?.enabledAt).toBe(marker);
		// already on: switching it on again is not a switch-on
		expect((await patch({ enabled: true })).status).toBe(200);
		expect((await stateOf())?.enabledAt).toBe(marker);
	});
	test('a switch-off landing between a switch-on reading the rule and writing it still gets a new marker', async () => {
		// one Team balance rule per server: the test before made this server's
		await env.db.delete(triggers).where(eq(triggers.serverId, w.otherServer.id));
		const made = await api('owner', 'POST api/servers/[id]/triggers', {
			params: { id: w.otherServer.id },
			body: { kind: 'two_teams', config: { balance: true }, enabled: false }
		});
		expect(made.status).toBe(201);
		const triggerId = (made.body as { trigger: { id: string } }).trigger.id;
		const patch = (enabled: boolean) =>
			api('owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { id: w.otherServer.id, triggerId },
				body: { enabled }
			});
		const markerOf = async () =>
			(
				(await env.db.select().from(triggers).where(eq(triggers.id, triggerId)))[0].state as {
					enabledAt?: number;
				} | null
			)?.enabledAt;
		expect((await patch(true)).status).toBe(200);
		const first = await markerOf();
		expect(typeof first).toBe('number');
		await Bun.sleep(5);
		// A switch-off holds the row: the switch-on reads it as on, then waits for the lock
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		let locked!: () => void;
		const isLocked = new Promise<void>((r) => (locked = r));
		const off = env.db.transaction(async (tx) => {
			await tx.update(triggers).set({ enabled: false }).where(eq(triggers.id, triggerId));
			locked();
			await held;
		});
		await isLocked;
		const switchOn = patch(true);
		await Bun.sleep(300);
		release();
		await off;
		expect((await switchOn).status).toBe(200);
		const [after] = await env.db.select().from(triggers).where(eq(triggers.id, triggerId));
		expect(after.enabled).toBe(true);
		expect((after.state as { enabledAt?: number }).enabledAt).not.toBe(first);
	});
});
