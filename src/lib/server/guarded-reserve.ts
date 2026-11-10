import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { OrgRow, SessionUser } from './access';
import { ApiError, str } from './http';
import { requireSteamId } from './steam';
import { listEntries, lists } from './db/schema';
import { listOf, parseExpiry, touch } from './lists';
import { gateway } from './gateway';
import { writeAudit } from './audit';

const receipt = (row: {
	id: string;
	steamId: string;
	expiresAt: Date | null;
	removedAt: Date | null;
}) => ({
	id: row.id,
	steamId: row.steamId,
	expiresAt: row.expiresAt?.toISOString() ?? null,
	removedAt: row.removedAt?.toISOString() ?? null
});

const expectedId = (body: Record<string, unknown>) => {
	if (
		typeof body.expectedEntryId !== 'string' ||
		!/^[a-zA-Z0-9:_-]{8,128}$/.test(body.expectedEntryId)
	)
		throw new ApiError(400, 'Valid expectedEntryId is required.', 'invalid_entry_id');
	return body.expectedEntryId;
};

/** Exact, unpaginated org-list lookup, never a server/member slot. */
export async function exactReservedEntry(env: Env, org: OrgRow, steamIdIn: unknown) {
	const steamId = requireSteamId(steamIdIn);
	const list = await listOf(env, org.id, 'reserve');
	const [entry] = await env.db
		.select()
		.from(listEntries)
		.where(
			and(
				eq(listEntries.listId, list.id),
				eq(listEntries.steamId, steamId),
				isNull(listEntries.removedAt)
			)
		)
		.limit(1);
	return entry
		? { ...receipt(entry), expired: entry.expiresAt !== null && entry.expiresAt <= new Date() }
		: null;
}

/** Exact immutable receipt history plus current org+Steam entry. */
export async function exactReservedEvidence(
	env: Env,
	org: OrgRow,
	steamIdIn: unknown,
	entryIdIn: unknown
) {
	const steamId = requireSteamId(steamIdIn);
	const entryId = expectedId({ expectedEntryId: entryIdIn });
	const list = await listOf(env, org.id, 'reserve');
	const [oldRows, current] = await Promise.all([
		env.db
			.select({
				id: listEntries.id,
				steamId: listEntries.steamId,
				expiresAt: listEntries.expiresAt,
				removedAt: listEntries.removedAt,
				removal: listEntries.removal
			})
			.from(listEntries)
			.where(
				and(
					eq(listEntries.id, entryId),
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, steamId)
				)
			)
			.limit(1),
		exactReservedEntry(env, org, steamId)
	]);
	const previous = oldRows[0];
	return {
		previous: previous
			? {
					id: previous.id,
					orgId: org.id,
					listId: list.id,
					steamId,
					expiresAt: previous.expiresAt?.toISOString() ?? null,
					removedAt: previous.removedAt?.toISOString() ?? null,
					removal: previous.removal
				}
			: null,
		current
	};
}

/** PostgreSQL compares immutable identity AND previous expiry in the same UPDATE. */
export async function guardedPatchReservedEntryCas(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	steamIdIn: unknown,
	body: Record<string, unknown>
) {
	const steamId = requireSteamId(steamIdIn);
	const id = expectedId(body);
	if (!Object.hasOwn(body, 'expectedExpiresAt') || !Object.hasOwn(body, 'expiresAt'))
		throw new ApiError(400, 'Expected and desired expiry are required.', 'invalid_expiry');
	const rawPrevious = body.expectedExpiresAt;
	if (
		rawPrevious !== null &&
		(typeof rawPrevious !== 'string' ||
			!Number.isFinite(Date.parse(rawPrevious)) ||
			new Date(rawPrevious).toISOString() !== rawPrevious)
	)
		throw new ApiError(400, 'Invalid expectedExpiresAt.', 'invalid_expiry');
	const previous = rawPrevious === null ? null : new Date(rawPrevious);
	const expiresAt = parseExpiry(body.expiresAt);
	const list = await listOf(env, org.id, 'reserve');
	const match = and(
		eq(listEntries.listId, list.id),
		eq(listEntries.steamId, steamId),
		eq(listEntries.id, id),
		isNull(listEntries.removedAt)
	);
	const [updated] = await env.db
		.update(listEntries)
		.set({ expiresAt })
		.where(and(match, sql`${listEntries.expiresAt} IS NOT DISTINCT FROM ${previous}`))
		.returning();
	let entry = updated;
	if (!entry) {
		const [found] = await env.db.select().from(listEntries).where(match).limit(1);
		if (!found) throw new ApiError(409, 'Entry has changed or was removed.', 'stale_entry');
		if (found.expiresAt?.getTime() !== expiresAt?.getTime())
			throw new ApiError(409, 'Entry expiry changed concurrently.', 'stale_expiry');
		entry = found;
	}
	if (updated) {
		await touch(env.db, list.id);
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: 'list.update',
			target: steamId,
			outcome: 'ok',
			message: 'Guarded reserved-slot expiry CAS',
			detail: { listId: list.id, entryId: id, expiresAt: entry.expiresAt?.toISOString() ?? null }
		});
	}
	const sync = await gateway().syncOrg(env, org);
	return { entry: receipt(entry), sync };
}

/** Stable primary key is the durable ADD receipt, even after a later removal. */
export async function guardedAddReservedEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
) {
	const steamId = requireSteamId(body.steamId);
	const operationId = body.operationId;
	if (typeof operationId !== 'string' || !/^[a-zA-Z0-9:_-]{16,128}$/.test(operationId))
		throw new ApiError(400, 'Stable operationId is required.', 'invalid_operation_id');
	const reason = str(body.reason, 200);
	const list = await listOf(env, org.id, 'reserve');
	const id =
		'infh_' +
		createHash('sha256')
			.update(list.id + ':' + operationId)
			.digest('hex');
	const inserted = await env.db.transaction(async (tx) => {
		// Serialize writers of the same list; the existing partial unique index is the backstop.
		await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, list.id));
		const [old] = await tx.select().from(listEntries).where(eq(listEntries.id, id)).limit(1);
		if (old) {
			if (old.listId !== list.id || old.steamId !== steamId)
				throw new ApiError(
					409,
					'Operation ID belongs to another resource.',
					'idempotency_conflict'
				);
			return false;
		}
		const expiresAt = parseExpiry(body.expiresAt);
		const [active] = await tx
			.select({ id: listEntries.id })
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			)
			.limit(1);
		if (active) throw new ApiError(409, 'A different active entry already exists.', 'duplicate');
		await tx.insert(listEntries).values({
			id,
			listId: list.id,
			steamId,
			reason,
			expiresAt,
			addedBy: actor.id,
			addedByName: actor.username
		});
		return true;
	});
	const [entry] = await env.db.select().from(listEntries).where(eq(listEntries.id, id)).limit(1);
	if (!entry) throw new ApiError(503, 'ADD receipt could not be read.', 'receipt_unavailable');
	if (inserted)
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: 'list.add',
			target: steamId,
			outcome: 'ok',
			message: 'Guarded reserved slot created',
			detail: { listId: list.id, entryId: id, expiresAt: entry.expiresAt?.toISOString() ?? null }
		});
	const sync = await gateway().syncOrg(env, org);
	return { entry: receipt(entry), replayed: !inserted, sync };
}

/** Guard and monotonic expiry comparison are both enforced in the UPDATE predicate. */
export async function guardedPatchReservedEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	steamIdIn: unknown,
	body: Record<string, unknown>
) {
	const steamId = requireSteamId(steamIdIn);
	const id = expectedId(body);
	if (!Object.hasOwn(body, 'expiresAt'))
		throw new ApiError(400, 'expiresAt is required.', 'invalid_expiry');
	const expiresAt = parseExpiry(body.expiresAt);
	const list = await listOf(env, org.id, 'reserve');
	const match = and(
		eq(listEntries.listId, list.id),
		eq(listEntries.steamId, steamId),
		eq(listEntries.id, id),
		isNull(listEntries.removedAt)
	);
	const [updated] = await env.db
		.update(listEntries)
		.set({ expiresAt })
		.where(expiresAt === null ? match : and(match, lt(listEntries.expiresAt, expiresAt)))
		.returning();
	const [entry] = updated
		? [updated]
		: await env.db.select().from(listEntries).where(match).limit(1);
	if (!entry) throw new ApiError(409, 'Entry replaced or removed.', 'stale_entry');
	if (updated) {
		await touch(env.db, list.id);
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: 'list.update',
			target: steamId,
			outcome: 'ok',
			message: 'Guarded reserve expiry extension',
			detail: { listId: list.id, entryId: id, expiresAt: entry.expiresAt?.toISOString() ?? null }
		});
	}
	const sync = await gateway().syncOrg(env, org);
	return { entry: receipt(entry), sync };
}

/** A late DELETE can only tombstone its exact immutable entry. */
export async function guardedRemoveReservedEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	steamIdIn: unknown,
	body: Record<string, unknown>
) {
	const steamId = requireSteamId(steamIdIn);
	const id = expectedId(body);
	const list = await listOf(env, org.id, 'reserve');
	const match = and(
		eq(listEntries.listId, list.id),
		eq(listEntries.steamId, steamId),
		eq(listEntries.id, id)
	);
	const [removed] = await env.db
		.update(listEntries)
		.set({
			removedAt: new Date(),
			removedBy: actor.id,
			removedByName: actor.username,
			removal: 'manual'
		})
		.where(and(match, isNull(listEntries.removedAt)))
		.returning({ id: listEntries.id });
	if (!removed) {
		const [old] = await env.db
			.select({ removedAt: listEntries.removedAt })
			.from(listEntries)
			.where(match)
			.limit(1);
		if (!old?.removedAt) throw new ApiError(409, 'Entry replaced or unknown.', 'stale_entry');
	} else {
		await touch(env.db, list.id);
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: 'list.remove',
			target: steamId,
			outcome: 'ok',
			message: 'Guarded reserved slot removed',
			detail: { listId: list.id, entryId: id }
		});
	}
	const sync = await gateway().syncOrg(env, org);
	return { entryId: id, removed: true, replayed: !removed, sync };
}
