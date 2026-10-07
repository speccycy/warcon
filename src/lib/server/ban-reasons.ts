// The org's quick reasons ($lib/ban-reasons): read for whoever may open the ban dialog, saved
// whole by an owner. The worker never reads them.
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { orgBanReasons } from './db/schema';
import {
	banReasonsProblem,
	cleanBanReason,
	DEFAULT_BAN_REASONS,
	storedBanReasons,
	type BanReason
} from '$lib/ban-reasons';

/** The org's own list, or the built-in six until its owners save one. */
export async function banReasonsFor(env: Env, orgId: string): Promise<BanReason[]> {
	const [row] = await env.db
		.select({ reasons: orgBanReasons.reasons })
		.from(orgBanReasons)
		.where(eq(orgBanReasons.orgId, orgId))
		.limit(1);
	return row ? storedBanReasons(row.reasons) : DEFAULT_BAN_REASONS;
}

/**
 * Owners: the quick reasons offered to anyone placing a ban in the org, in order; null puts back
 * the built-in six. Bans already placed keep their reasons.
 */
export async function setBanReasons(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	value: unknown
): Promise<BanReason[]> {
	let reasons: BanReason[] | null = null;
	if (value !== null) {
		if (!Array.isArray(value))
			throw new ApiError(400, 'Send the quick reasons as a list, or null for the built-in six.');
		reasons = value.map(cleanBanReason);
		const problem = banReasonsProblem(reasons);
		if (problem) throw new ApiError(400, problem);
	}
	if (reasons)
		await env.db
			.insert(orgBanReasons)
			.values({ orgId: org.id, reasons, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: orgBanReasons.orgId,
				set: { reasons, updatedAt: new Date() }
			});
	else await env.db.delete(orgBanReasons).where(eq(orgBanReasons.orgId, org.id));
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.ban_reasons',
		outcome: 'ok',
		target: org.name,
		message: reasons ? 'Quick reasons changed' : 'Quick reasons back to the built-in six',
		detail: { orgId: org.id, banReasons: reasons }
	});
	return reasons ?? DEFAULT_BAN_REASONS;
}
