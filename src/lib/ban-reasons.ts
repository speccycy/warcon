// The organisation's quick reasons: the buttons under Reason in the ban dialog. Each has a short
// name for the button, the reason it fills in, and the length it sets, if any. Shared by the
// editor on the Ban list page, the dialog and the server's check of what an owner saves.
import { EXPIRY_OPTIONS } from './lists';

export interface BanReason {
	/** what the button says */
	label: string;
	/** what it fills in as the ban's reason */
	reason: string;
	/** the length it sets in Expires, in days, 0 for permanent; null leaves Expires as it is */
	days: number | null;
}

/** What an org offers until its owners save a list of their own. */
export const DEFAULT_BAN_REASONS: BanReason[] = [
	'Cheating',
	'Team killing',
	'Toxic behaviour',
	'Racism / hate speech',
	'Ban evasion',
	'Griefing'
].map((reason) => ({ label: reason, reason, days: null }));

export const MAX_BAN_REASONS = 20;
export const MAX_BAN_REASON_LABEL = 32;
/** The reason's own cap on a list entry. */
export const MAX_BAN_REASON = 200;

/** The lengths a quick reason may set: the dialog's own Expires choices, in days. */
export const BAN_REASON_DAYS: number[] = EXPIRY_OPTIONS.flatMap(([value]) =>
	value === 'custom' ? [] : [Number(value)]
);

/** How the length reads in the editor: "Not set", "Permanent", "7 days". */
export const lengthLabel = (days: number | null): string =>
	days === null
		? 'Not set'
		: (EXPIRY_OPTIONS.find(([value]) => value === String(days))?.[1] ?? `${days} days`);

/** How the length reads on the button, as the ban message's {duration} writes it: Perm, 7d. */
export const lengthTag = (days: number | null): string =>
	days === null ? '' : days === 0 ? 'Perm' : `${days}d`;

const oneLine = (value: unknown, max: number): string =>
	String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
		.trim();

/** One row as typed or sent, each text on one line and cut to its cap. */
export function cleanBanReason(raw: unknown): BanReason {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	// anything but a number or nothing is no length at all: NaN, which the check refuses
	const days =
		o.days === null || o.days === undefined ? null : typeof o.days === 'number' ? o.days : NaN;
	return {
		label: oneLine(o.label, MAX_BAN_REASON_LABEL),
		reason: oneLine(o.reason, MAX_BAN_REASON),
		days
	};
}

/** What stops a list from being saved, in a sentence, or '' when nothing does. */
export function banReasonsProblem(list: BanReason[]): string {
	if (list.length > MAX_BAN_REASONS)
		return `An organisation keeps at most ${MAX_BAN_REASONS} quick reasons.`;
	if (list.some((r) => !r.label || !r.reason))
		return 'Each quick reason needs a short name and a reason.';
	const names = list.map((r) => r.label.toLowerCase());
	if (new Set(names).size !== names.length) return 'Two quick reasons have the same short name.';
	if (list.some((r) => r.days !== null && !BAN_REASON_DAYS.includes(r.days)))
		return `A length is one of ${BAN_REASON_DAYS.map(lengthLabel).join(', ')}, or not set.`;
	return '';
}

/** A stored list, trusted but read defensively: anything that would not save is left out. */
export function storedBanReasons(raw: unknown): BanReason[] {
	if (!Array.isArray(raw)) return DEFAULT_BAN_REASONS;
	const out: BanReason[] = [];
	for (const item of raw.slice(0, MAX_BAN_REASONS)) {
		const r = cleanBanReason(item);
		if (!banReasonsProblem([...out, r])) out.push(r);
	}
	return out;
}
