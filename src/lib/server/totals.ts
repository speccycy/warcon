// Each player's settled totals per server (player_totals) are kept by triggers in the database
// (migration 0038): a session closing or a match ending adds to them, and any other change to the
// sessions, matches or lines recounts the pairs it touched. Every trigger takes the server's
// totals lock before it reads or writes; whoever closes a session, ends a match or purges takes it
// first, before its first row, so that two of them never wait for each other while each holds
// something the other needs (a purge holding the lock and wanting the match row a match end has
// already updated, for one).
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db';

/** The server's totals lock, held to the end of the transaction (re-entrant). */
export async function lockTotals(db: DbOrTx, serverId: string): Promise<void> {
	await db.execute(sql`SELECT player_totals_lock(${serverId})`);
}
