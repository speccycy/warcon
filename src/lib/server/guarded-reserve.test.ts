import { beforeAll, afterAll, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';

const testDatabaseUrl = process.env.WARCON_ISSUE95_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
	describe.skip('WARCON guarded SQL contract (requires explicit disposable DB)', () => {
		it('runs only with WARCON_ISSUE95_TEST_DATABASE_URL set', () => {});
	});
} else {
	// Never run a destructive fixture against persistent development or production.
	const localFixture =
		testDatabaseUrl === 'postgres://infh-dev@127.0.0.1:55495/warcon_issue95_test';
	const ciFixture =
		process.env.CI === 'true' &&
		testDatabaseUrl === 'postgres://warcon:warcon@127.0.0.1:5432/warcon_issue95_test';
	if (!localFixture && !ciFixture) {
		throw new Error('Guarded SQL test requires the exact local or CI disposable fixture URL.');
	}
	mock.module('./audit', () => ({ writeAudit: async () => {} }));
	mock.module('./gateway', () => ({
		gateway: () => ({
			syncOrg: async () => ({ servers: [{ ok: true, failed: 0, pending: false }] })
		})
	}));

	const { connect, schema } = await import('./db');
	const {
		exactReservedEntry,
		guardedAddReservedEntry,
		guardedPatchReservedEntry,
		guardedPatchReservedEntryCas,
		exactReservedEvidence,
		guardedRemoveReservedEntry
	} = await import('./guarded-reserve');

	const connection = connect(testDatabaseUrl);
	const env = { db: connection.db } as any;
	const org = { id: 'org-test', name: 'Isolated fixture' } as any;
	const actor = { id: 'fixture-admin', username: 'fixture-admin' } as any;
	const req = new Request('http://localhost/api/orgs/org-test/lists/reserve/entries/guarded', {
		method: 'POST'
	});
	const steamId = '76561198000000000';
	let originalEntryId = '';

	beforeAll(async () => {
		await connection.db.delete(schema.listEntries);
	});
	afterAll(async () => {
		await connection.client.close();
	});

	describe('WARCON guarded contract on disposable PostgreSQL 18', () => {
		it('creates one ADD receipt with finite expiry and safely replays the same operation', async () => {
			const created = await guardedAddReservedEntry(env, req, actor, org, {
				steamId,
				operationId: 'purchase_fixed_operation_001',
				reason: 'INFH fixture',
				expiresAt: '2026-12-01T00:00:00Z'
			});
			expect(created.entry.expiresAt).toBe('2026-12-01T00:00:00.000Z');
			expect(created.replayed).toBe(false);
			originalEntryId = created.entry.id;
			const retried = await guardedAddReservedEntry(env, req, actor, org, {
				steamId,
				operationId: 'purchase_fixed_operation_001',
				reason: 'INFH fixture',
				expiresAt: '2020-01-01T00:00:00Z' // past expiry must not block recovery of a prior ADD
			});
			expect(retried.entry.id).toBe(originalEntryId);
			expect(retried.replayed).toBe(true);
			expect(
				await connection.db
					.select()
					.from(schema.listEntries)
					.where(eq(schema.listEntries.steamId, steamId))
			).toHaveLength(1);
		});

		it('extends the same immutable Entry ID and never shortens a longer expiry', async () => {
			const patched = await guardedPatchReservedEntry(env, req, actor, org, steamId, {
				expectedEntryId: originalEntryId,
				expiresAt: '2027-01-01T00:00:00Z'
			});
			expect(patched.entry.id).toBe(originalEntryId);
			expect(patched.entry.expiresAt).toBe('2027-01-01T00:00:00.000Z');
			const shorter = await guardedPatchReservedEntry(env, req, actor, org, steamId, {
				expectedEntryId: originalEntryId,
				expiresAt: '2026-12-15T00:00:00Z'
			});
			expect(shorter.entry.expiresAt).toBe('2027-01-01T00:00:00.000Z');
		});

		it('never deletes or patches a replacement manual entry with an old receipt', async () => {
			const first = await guardedRemoveReservedEntry(env, req, actor, org, steamId, {
				expectedEntryId: originalEntryId
			});
			expect(first.removed).toBe(true);
			await connection.db.insert(schema.listEntries).values({
				id: 'manual-replacement',
				listId: 'list-reserve',
				steamId,
				reason: 'Manual owner',
				addedByName: 'WARCON admin'
			});
			const old = await guardedRemoveReservedEntry(env, req, actor, org, steamId, {
				expectedEntryId: originalEntryId
			});
			expect(old.replayed).toBe(true);
			await expect(
				guardedPatchReservedEntry(env, req, actor, org, steamId, {
					expectedEntryId: originalEntryId,
					expiresAt: '2027-02-01T00:00:00Z'
				})
			).rejects.toMatchObject({ code: 'stale_entry' });
			const current = await exactReservedEntry(env, org, steamId);
			expect(current?.id).toBe('manual-replacement');
			await expect(
				guardedAddReservedEntry(env, req, actor, org, {
					steamId,
					operationId: 'purchase_new_operation_002',
					reason: 'Must not replace manual',
					expiresAt: '2027-01-01T00:00:00Z'
				})
			).rejects.toMatchObject({ code: 'duplicate' });
			const replayed = await guardedAddReservedEntry(env, req, actor, org, {
				steamId,
				operationId: 'purchase_fixed_operation_001',
				reason: 'Old operation replay',
				expiresAt: '2026-12-01T00:00:00Z'
			});
			expect(replayed.entry.removedAt).toBeTruthy();
			expect((await exactReservedEntry(env, org, steamId))?.id).toBe('manual-replacement');
		});

		it('CAS supports null/finite and shorter/longer changes on one immutable ID', async () => {
			const sid = '76561198000000080';
			const created = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'cas_operation_identity_0001',
				reason: 'expiry fixture',
				expiresAt: null
			});
			const id = created.entry.id;
			const cas = (oldExpiry: string | null, nextExpiry: string | null) =>
				guardedPatchReservedEntryCas(env, req, actor, org, sid, {
					expectedEntryId: id,
					expectedExpiresAt: oldExpiry,
					expiresAt: nextExpiry
				});
			let current = await cas(null, '2027-01-01T00:00:00.000Z');
			expect(current.entry).toMatchObject({ id, expiresAt: '2027-01-01T00:00:00.000Z' });
			await expect(cas(null, '2027-02-01T00:00:00.000Z')).rejects.toMatchObject({
				code: 'stale_expiry'
			});
			current = await cas('2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z');
			expect(current.entry.expiresAt).toBe('2028-01-01T00:00:00.000Z');
			current = await cas('2028-01-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z');
			expect(current.entry.expiresAt).toBe('2027-03-01T00:00:00.000Z');
			current = await cas('2027-03-01T00:00:00.000Z', null);
			expect(current.entry).toMatchObject({ id, expiresAt: null });
			current = await cas('2027-03-01T00:00:00.000Z', null);
			expect(current.entry).toMatchObject({ id, expiresAt: null }); // Same desired value: idempotent.
			await expect(
				guardedPatchReservedEntryCas(env, req, actor, org, sid, {
					expectedEntryId: 'wrong-entry-id',
					expectedExpiresAt: null,
					expiresAt: '2028-01-01T00:00:00.000Z'
				})
			).rejects.toMatchObject({ code: 'stale_entry' });
			expect((await exactReservedEntry(env, org, sid))?.id).toBe(id);
		});

		it('rejects a concurrent late stale CAS without overwriting the winner', async () => {
			const sid = '76561198000000081';
			const created = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'cas_operation_identity_0002',
				reason: 'racing fixture',
				expiresAt: '2027-01-01T00:00:00.000Z'
			});
			const results = await Promise.allSettled([
				guardedPatchReservedEntryCas(env, req, actor, org, sid, {
					expectedEntryId: created.entry.id,
					expectedExpiresAt: '2027-01-01T00:00:00.000Z',
					expiresAt: '2027-04-01T00:00:00.000Z'
				}),
				guardedPatchReservedEntryCas(env, req, actor, org, sid, {
					expectedEntryId: created.entry.id,
					expectedExpiresAt: '2027-01-01T00:00:00.000Z',
					expiresAt: '2027-05-01T00:00:00.000Z'
				})
			]);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect(
				(results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
			).toMatchObject({ code: 'stale_expiry' });
			const winner = results.find(
				(result) => result.status === 'fulfilled'
			) as PromiseFulfilledResult<any>;
			expect((await exactReservedEntry(env, org, sid))?.expiresAt).toBe(
				winner.value.entry.expiresAt
			);
		});

		it('returns exact expired and manual tombstones, not absence inferred from GET', async () => {
			const sid = '76561198000000082';
			const created = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'expired_receipt_operation_001',
				reason: 'expired fixture',
				expiresAt: '2027-01-01T00:00:00.000Z'
			});
			await connection.db
				.update(schema.listEntries)
				.set({
					removedAt: new Date('2026-11-10T00:00:00Z'),
					removal: 'expired',
					removedByName: 'expiry'
				})
				.where(eq(schema.listEntries.id, created.entry.id));
			const vanished = await exactReservedEntry(env, org, sid);
			expect(vanished).toBeNull();
			const tombstone = await exactReservedEvidence(env, org, sid, created.entry.id);
			expect(tombstone.previous).toMatchObject({
				id: created.entry.id,
				listId: 'list-reserve',
				orgId: 'org-test',
				removedAt: '2026-11-10T00:00:00.000Z',
				removal: 'expired'
			});
			expect(tombstone.current).toBeNull();
			const replacement = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'replacement_operation_001',
				reason: 'new cycle',
				expiresAt: '2027-06-01T00:00:00.000Z'
			});
			const replay = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'replacement_operation_001',
				reason: 'retry',
				expiresAt: '2027-06-01T00:00:00.000Z'
			});
			expect(replay.entry.id).toBe(replacement.entry.id);
			expect(replay.replayed).toBe(true);
			expect(replacement.entry.id).not.toBe(created.entry.id);
			const delayedDelete = await guardedRemoveReservedEntry(env, req, actor, org, sid, {
				expectedEntryId: created.entry.id
			});
			expect(delayedDelete.replayed).toBe(true);
			expect((await exactReservedEntry(env, org, sid))?.id).toBe(replacement.entry.id);
			const evidenceWithReplacement = await exactReservedEvidence(env, org, sid, created.entry.id);
			expect(evidenceWithReplacement.current?.id).toBe(replacement.entry.id);

			const manual = await guardedRemoveReservedEntry(env, req, actor, org, sid, {
				expectedEntryId: replacement.entry.id
			});
			expect(manual.removed).toBe(true);
			expect(
				(await exactReservedEvidence(env, org, sid, replacement.entry.id)).previous?.removal
			).toBe('manual');
		});

		it('resolves the exact identity despite 2000 unrelated rows', async () => {
			await connection.db.insert(schema.listEntries).values(
				Array.from({ length: 2001 }, (_, i) => ({
					id: 'unrelated-' + i,
					listId: 'list-reserve',
					steamId: (76561198001000000n + BigInt(i)).toString(),
					reason: 'fixture',
					addedByName: 'fixture'
				}))
			);
			const exact = await exactReservedEntry(env, org, steamId);
			expect(exact?.id).toBe('manual-replacement');
		});
		it('SvelteKit routes expose CAS, tombstone lookup and advertised capabilities', async () => {
			const actualAccess = await import('./access');
			const { ApiError } = await import('./http');
			let denied = false;
			mock.module('$lib/server/access', () => ({
				...actualAccess,
				requireListsRole: async () => {
					if (denied) throw new ApiError(403, 'Access denied', 'forbidden');
					return { org, user: actor };
				}
			}));
			mock.module('$lib/server/env', () => ({ getEnv: () => env }));
			const casRoute =
				await import('../../routes/api/orgs/[id]/lists/[kind]/entries/[steamId]/guarded-cas/+server');
			const entryRoute =
				await import('../../routes/api/orgs/[id]/lists/[kind]/entries/[steamId]/guarded/+server');
			const capabilitiesRoute =
				await import('../../routes/api/orgs/[id]/lists/[kind]/entries/guarded/+server');
			const sid = '76561198000000083';
			const created = await guardedAddReservedEntry(env, req, actor, org, {
				steamId: sid,
				operationId: 'http_route_contract_operation_001',
				reason: 'route test',
				expiresAt: null
			});
			const params = { id: 'org-test', kind: 'reserve', steamId: sid };
			const url = new URL(
				'http://localhost/api/orgs/org-test/lists/reserve/entries/' + sid + '/guarded-cas'
			);
			const event = (method: string, path: URL, body?: unknown) => ({
				params,
				url: path,
				locals: {},
				request: new Request(path, {
					method,
					...(body === undefined
						? {}
						: {
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify(body)
							})
				})
			});
			const capResponse = await capabilitiesRoute.GET(event('GET', url) as any);
			expect(capResponse.status).toBe(200);
			const cap = await capResponse.json();
			expect(cap.capabilities).toContain('expiry-cas');
			expect(cap.capabilities).toContain('entry-tombstone');

			denied = true;
			const forbidden = await casRoute.PATCH(
				event('PATCH', url, {
					expectedEntryId: created.entry.id,
					expectedExpiresAt: null,
					expiresAt: '2027-08-01T00:00:00.000Z'
				}) as any
			);
			expect(forbidden.status).toBe(403);
			expect((await forbidden.json()).error?.code).toBe('forbidden');
			denied = false;
			const response = await casRoute.PATCH(
				event('PATCH', url, {
					expectedEntryId: created.entry.id,
					expectedExpiresAt: null,
					expiresAt: '2027-08-01T00:00:00.000Z'
				}) as any
			);
			expect(response.status).toBe(200);
			expect((await response.json()).entry).toMatchObject({
				id: created.entry.id,
				expiresAt: '2027-08-01T00:00:00.000Z'
			});
			const stale = await casRoute.PATCH(
				event('PATCH', url, {
					expectedEntryId: created.entry.id,
					expectedExpiresAt: null,
					expiresAt: '2027-09-01T00:00:00.000Z'
				}) as any
			);
			expect(stale.status).toBe(409);
			expect((await stale.json()).error?.code).toBe('stale_expiry');

			await connection.db
				.update(schema.listEntries)
				.set({
					removedAt: new Date('2026-11-10T00:00:00Z'),
					removal: 'expired',
					removedByName: 'expiry'
				})
				.where(eq(schema.listEntries.id, created.entry.id));
			const evidenceUrl = new URL(
				'http://localhost/api/orgs/org-test/lists/reserve/entries/' + sid + '/guarded'
			);
			evidenceUrl.searchParams.set('expectedEntryId', created.entry.id);
			const tombstone = await entryRoute.GET(event('GET', evidenceUrl) as any);
			expect(tombstone.status).toBe(200);
			expect((await tombstone.json()).evidence).toMatchObject({
				previous: {
					id: created.entry.id,
					removal: 'expired',
					orgId: 'org-test',
					listId: 'list-reserve'
				},
				current: null
			});
		});
	});
}
