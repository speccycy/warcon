// Which process owns observation and delivery. One row in worker_ownership holds a token and a
// lease; the owner renews it every few seconds, and any other process takes over once the lease
// has lapsed. Every worker write runs through withOwnedTransaction, which re-checks the token
// inside the transaction (FOR SHARE), so a worker that lost the lease can never write late.
import { eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { Tx } from './db';
import { workerOwnership } from './db/schema';
import { lockTotals } from './totals';

const ROW_ID = 1;
export const LEASE_MS = 15_000;

const token = crypto.randomUUID();
let owner = false;
let since = 0;
/** When this process's current period as owner began, by its own clock (see ownedSince). */
let sinceHere = 0;
let lastRenewAt = 0;

export class LostOwnership extends Error {
	constructor() {
		super('This process no longer owns the worker lease.');
	}
}

/** Work prepared while this process owned the lease before: it changed hands since, and came back. */
export class StaleOwnership extends Error {
	constructor() {
		super('The lease changed hands after this work was prepared; it is dropped.');
	}
}

/** Takes the lease if it is free or ours; renews it if ours. Returns whether we own it now. */
export async function acquireOrRenew(env: Env, label: string): Promise<boolean> {
	const until = new Date(Date.now() + LEASE_MS);
	const rows = await env.db
		.insert(workerOwnership)
		.values({ id: ROW_ID, token, label, leaseUntil: until })
		.onConflictDoUpdate({
			target: workerOwnership.id,
			set: {
				token,
				label,
				leaseUntil: until,
				acquiredAt: sql`CASE WHEN ${workerOwnership.token} = ${token} THEN ${workerOwnership.acquiredAt} ELSE now() END`
			},
			setWhere: sql`${workerOwnership.token} = ${token} OR ${workerOwnership.leaseUntil} < now()`
		})
		.returning({ token: workerOwnership.token, acquiredAt: workerOwnership.acquiredAt });
	const now = !!rows.length && rows[0].token === token;
	if (now) {
		// acquired_at is reset whenever the token changed hands, even if we never saw the loss.
		const period = rows[0].acquiredAt.getTime();
		if (!owner || period !== since) {
			console.log(`[warcon] this process owns the worker (${label})`);
			sinceHere = Date.now();
		}
		since = period;
	}
	if (!now && owner) console.warn('[warcon] lost the worker lease; another process owns it');
	owner = now;
	if (now) lastRenewAt = Date.now();
	return owner;
}

/** Gives the lease up cleanly (shutdown), so the next process need not wait for it to lapse. */
export async function releaseOwnership(env: Env): Promise<void> {
	if (!owner) return;
	owner = false;
	await env.db
		.update(workerOwnership)
		.set({ leaseUntil: new Date(0) })
		.where(eq(workerOwnership.token, token))
		.catch(() => {});
}

/**
 * When this process last became the owner, by its own clock: anything it observed before then (a
 * player list) belongs to a period in which another process may have acted.
 */
export const ownedSince = (): number => sinceHere;

/**
 * Which period of ownership this is: worker_ownership.acquired_at, which changes whenever the lease
 * changes hands. Work captures it when it reads the game and passes it to withOwnedTransaction.
 */
export const ownershipPeriod = (): number => since;

/** Owner, and the last renewal landed within the lease: a stalled renewal is a lost lease. */
export const isOwner = (): boolean => owner && Date.now() - lastRenewAt < LEASE_MS;
export const ownershipStats = () => ({ owner, token: token.slice(0, 8), since, lastRenewAt });

/**
 * A transaction that aborts unless this process still holds the lease at commit time. `totalsOf`
 * takes that server's totals lock first (totals.ts), before the lease row: a transaction waiting
 * for the lock (a purge of the server holds it) must not hold the row the renewal updates, or one
 * slow purge would stall the lease and with it every server. Holding nothing on the lease row while
 * it waits, the lease can change hands and come back meanwhile; `period` (ownershipPeriod() when the
 * work read the game) refuses the work then, rather than write it over what the other process
 * wrote, and leaves the lease as it is.
 */
export async function withOwnedTransaction<T>(
	env: Env,
	fn: (tx: Tx) => Promise<T>,
	opts: { totalsOf?: string; period?: number } = {}
): Promise<T> {
	if (!owner) throw new LostOwnership();
	return env.db.transaction(async (tx) => {
		if (opts.totalsOf) await lockTotals(tx, opts.totalsOf);
		const [row] = await tx
			.select({
				token: workerOwnership.token,
				leaseUntil: workerOwnership.leaseUntil,
				acquiredAt: workerOwnership.acquiredAt
			})
			.from(workerOwnership)
			.where(eq(workerOwnership.id, ROW_ID))
			.for('share');
		if (!row || row.token !== token || row.leaseUntil.getTime() < Date.now()) {
			owner = false;
			throw new LostOwnership();
		}
		if (opts.period !== undefined && row.acquiredAt.getTime() !== opts.period)
			throw new StaleOwnership();
		return fn(tx);
	});
}
