// The Name change watch rule's pure part: names read as they show on screen, and when the name a
// player shows calls for the rule. The game's player list holds the name a player joined with (a
// clan tag changed mid-game is the one change it follows); a name changed mid-game shows only in
// the kill feed, which names both players of every kill as the others see them. So a player the
// feed shows under a name that does not read as the one the list holds for them has changed it,
// and one whose shown name reads as another listed player's is taking it. Live, each kill batch is
// held against the player list of that moment (feed-events.ts); the dry run holds the day's kills
// against the sessions open at each (triggers.ts). No database, no game server; both go through
// nameChangeStep.
import { int, str } from './http';
import { fold } from './name-fold';
import { settingsFingerprint } from './fingerprint';

export interface NameChangeConfig {
	/** count a change only when the name shown is another listed player's; otherwise every change
	 *  counts */
	takenOnly: boolean;
	/** act once one player's counted changes within the window reach this many; 1 is every change */
	changes: number;
	/** also how long the rule remembers a player, so it bounds the worker's memory */
	windowMinutes: number;
	/** `alert` writes the audit row (and so the Discord card) and leaves the player on */
	action: 'alert' | 'kick';
	/** a kick rule flags a player with a reserved slot instead of kicking them */
	spareReserved: boolean;
	reason: string;
}

export function validateNameChange(c: Record<string, unknown>): NameChangeConfig {
	return {
		takenOnly: !!c.takenOnly,
		changes: int(c.changes, 1, 1, 20),
		windowMinutes: int(c.windowMinutes, 10, 1, 120),
		action: c.action === 'kick' ? 'kick' : 'alert',
		spareReserved: c.spareReserved === undefined ? true : !!c.spareReserved,
		reason: str(c.reason, 200) || 'Changing your name mid-game is not allowed here.'
	};
}

/**
 * The settings a rule's flags and kicks were decided under: delivery sends them only while the rule
 * still holds these (outbox.ts), so switching off a rule that is kicking the wrong players stops
 * what it has queued.
 */
export const nameChangeSettingsKey = (cfg: NameChangeConfig): string => settingsFingerprint(cfg);

/** What changes nothing on screen: spaces, format characters, the fillers that pass for a blank,
 *  punctuation and symbols (a dot, a tilde or an emoji added is no new name). */
const UNSEEN = /[\s\p{Cf}\p{P}\p{S}ᅟᅠㅤﾠ⠀]+/gu;
/** Letters that pass for Latin ones and that name-fold.ts leaves as they are. */
const MORE_LOOKALIKES: Record<string, string> = {
	ı: 'i',
	ɩ: 'i',
	ӏ: 'i',
	ɑ: 'a',
	օ: 'o',
	ս: 'u',
	ո: 'n',
	հ: 'h',
	һ: 'h',
	ց: 'g',
	ԛ: 'q',
	ԝ: 'w',
	ѡ: 'w',
	ү: 'y'
};
const MORE = new RegExp(`[${Object.keys(MORE_LOOKALIKES).join('')}]`, 'gu');
/** A clan tag in brackets at the front or the back of a name (read after NFKC, so fullwidth
 *  brackets are plain ones). */
const TAG =
	/^\s*[[({<【「『〔][^\])}>】」』〕]{1,12}[\])}>】」』〕]|[[({<【「『〔][^\])}>】」』〕]{1,12}[\])}>】」』〕]\s*$/gu;
/** A name that matches another only once a clan tag is taken off is a copy from this length on;
 *  shorter ones ("Alex", "[ABC] Alex") are too common to be. */
const MIN_CORE = 5;

// | is a symbol, so it is read as i before the symbols go.
const reading = (folded: string): string =>
	folded
		.replace(MORE, (c) => MORE_LOOKALIKES[c])
		.replace(/\|/g, 'i')
		.replace(UNSEEN, '')
		.replace(/[l1]/g, 'i')
		.replace(/0/g, 'o');

/** How a name reads on screen (`key`), and without a clan tag (`core`). */
export interface NameReading {
	key: string;
	core: string;
}

/**
 * A name as it reads on screen: case, accents, compatibility forms and look-alike letters from
 * other alphabets folded (name-fold.ts and MORE_LOOKALIKES), what changes nothing on screen gone,
 * and the characters that pass for one another read as one (I, l, 1 and | as i; 0 as o). A name
 * made of nothing else reads as itself.
 */
export function readName(name: string): NameReading {
	const folded = fold(name);
	const key = reading(folded) || name.trim();
	return { key, core: reading(folded.replace(TAG, '')) || key };
}
export const nameKey = (name: string): string => readName(name).key;

/**
 * Two names another player would take for one: they read the same, or one is the other with a
 * clan tag put on or taken off (and long enough not to be a coincidence). A tag swapped for
 * another is another player.
 */
const sameName = (a: NameReading, b: NameReading): boolean =>
	a.key === b.key ||
	(a.core === b.core && a.core.length >= MIN_CORE && (a.core === a.key || b.core === b.key));

/** Their own name: it reads the same, or the same with a clan tag put on, taken off or swapped. */
const ownName = (shown: NameReading, listed: NameReading): boolean =>
	shown.key === listed.key || shown.core === listed.core;

/** One player as the kill feed named them at one kill. */
export interface ShownName {
	steamId: string;
	name: string;
}

/**
 * What the rule remembers of a player the feed has shown under a name not their own: how the name
 * it last showed reads ('' once it is their own again), their counted changes still inside the
 * window (ms, oldest first), when the rule last acted on them, and when the feed last named them.
 * A player always shown under their own name has none.
 */
export interface NameTrack {
	shown: string;
	changes: readonly number[];
	actedAt: number | null;
	seenAt: number;
}
export type NameTracks = Map<string, NameTrack>;

const NONE: readonly never[] = Object.freeze([]);

export interface NameChangeHit<P> {
	player: P;
	/** the name the server lists them under */
	listed: string;
	/** the SteamID of the listed player whose name they show, when it is someone else's */
	holder: string | null;
	/** counted changes in the window, this one included */
	count: number;
	verdict: string;
}

/**
 * The names a batch of kills showed, in the order they were played, held against the names the
 * server lists its players under (`listed`). A player not on the list is not judged: they have
 * left, or the list is between maps. A player shown under a name that does not read as their listed
 * one has changed it; the change counts when the name reads as another listed player's, or, unless
 * the rule counts only those, whatever it is. Showing the same name again is no new change, nor is
 * going back to one's own.
 *
 * The rule acts once a player's counted changes within the window reach its count, and counts from
 * nothing again: an alert rule tells staff about a player once a window, a kick rule acts at every
 * count it reaches. A player it kicks (`kicked`; one with a reserved slot may be flagged instead) is
 * remembered under their own name, so showing the taken name again after coming back is a change
 * again: a kick is no answer if the player can reconnect and carry on.
 *
 * The tracks move on at once, so a batch read while another is being written sees its changes;
 * `undo` puts them back for a batch whose actions could not be written. `readings` keeps the names
 * read across calls (the dry run's whole replay).
 */
export function nameChangeStep<P extends ShownName>(
	cfg: NameChangeConfig,
	tracks: NameTracks,
	shown: readonly P[],
	listed: ReadonlyMap<string, string>,
	now: number,
	opts: { kicked?: (steamId: string) => boolean; readings?: Map<string, NameReading> } = {}
): { hits: NameChangeHit<P>[]; undo: () => void } {
	const from = now - cfg.windowMinutes * 60_000;
	const readings = opts.readings ?? new Map<string, NameReading>();
	const read = (name: string): NameReading => {
		let r = readings.get(name);
		if (!r) readings.set(name, (r = readName(name)));
		return r;
	};
	const before = new Map<string, NameTrack | undefined>();
	const move = (steamId: string, t: NameTrack) => {
		if (!before.has(steamId)) before.set(steamId, tracks.get(steamId));
		tracks.set(steamId, t);
	};
	const hits: NameChangeHit<P>[] = [];
	for (const p of shown) {
		const own = listed.get(p.steamId);
		if (own === undefined || !p.name.trim()) continue;
		const r = p.name === own ? null : read(p.name);
		const key = !r || ownName(r, read(own)) ? '' : r.key;
		const was = tracks.get(p.steamId);
		const t: NameTrack =
			was && was.seenAt >= from ? was : { shown: '', changes: NONE, actedAt: null, seenAt: now };
		if (key === t.shown) {
			if (t === was) move(p.steamId, { ...t, seenAt: now });
			continue;
		}
		const holder = r && key ? holderOf(listed, p.steamId, r, read) : null;
		const counts = !!key && (holder !== null || !cfg.takenOnly);
		const times = t.changes.filter((at) => at >= from);
		if (counts) times.push(now);
		// an alert rule has told staff about this player within the window already
		const told = cfg.action !== 'kick' && t.actedAt !== null && t.actedAt >= from;
		const act = counts && !told && times.length >= cfg.changes;
		move(p.steamId, {
			shown: act && opts.kicked?.(p.steamId) ? '' : key,
			changes: act ? NONE : times,
			actedAt: act ? now : t.actedAt,
			seenAt: now
		});
		if (!act) continue;
		const verdict = `shown as ${p.name}${holder ? `, the name of ${holder}` : ''}${times.length > 1 ? ` (${times.length} changes in ${cfg.windowMinutes} min)` : ''}`;
		hits.push({ player: p, listed: own, holder, count: times.length, verdict });
	}
	return {
		hits,
		undo: () => {
			for (const [id, t] of before)
				if (t) tracks.set(id, t);
				else tracks.delete(id);
		}
	};
}

/** The listed player, other than this one, whose name the shown one reads as; null for none. */
function holderOf(
	listed: ReadonlyMap<string, string>,
	steamId: string,
	r: NameReading,
	read: (name: string) => NameReading
): string | null {
	for (const [id, name] of listed) if (id !== steamId && sameName(read(name), r)) return id;
	return null;
}

/** Forgets players the feed has not named within the window: their next sighting starts afresh. */
export function pruneNameTracks(cfg: NameChangeConfig, tracks: NameTracks, now: number): void {
	const from = now - cfg.windowMinutes * 60_000;
	for (const [id, t] of tracks) if (t.seenAt < from) tracks.delete(id);
}

/** A name the feed showed for a player that was not the one the list held for them. */
export interface ShownElse {
	steamId: string;
	name: string;
	/** the listed player whose name it read as, when it was someone else's */
	holder: string | null;
}

/**
 * The names some kills showed that were not the ones the list held for their players (their own
 * name with a clan tag put on, taken off or swapped is the same name), each player's name once,
 * with the listed player whose name it read as. A player not on the list, or shown under a blank
 * name, is not judged. `readings` keeps the names read across calls.
 */
export function namesShownElse(
	shown: readonly ShownName[],
	listed: ReadonlyMap<string, string>,
	readings: Map<string, NameReading> = new Map()
): ShownElse[] {
	const read = (name: string): NameReading => {
		let r = readings.get(name);
		if (!r) readings.set(name, (r = readName(name)));
		return r;
	};
	const out = new Map<string, ShownElse>();
	for (const p of shown) {
		const own = listed.get(p.steamId);
		if (own === undefined || p.name === own || !p.name.trim()) continue;
		const key = `${p.steamId}\n${p.name}`;
		if (out.has(key)) continue;
		const r = read(p.name);
		if (ownName(r, read(own))) continue;
		out.set(key, {
			steamId: p.steamId,
			name: p.name,
			holder: holderOf(listed, p.steamId, r, read)
		});
	}
	return [...out.values()];
}

/** One session as a replay reads it: who was listed under which name, from when until when. */
export interface ListedSession {
	steamId: string;
	name: string;
	joinedAt: Date | string;
	leftAt: Date | string | null;
}

/**
 * The player list as a server's sessions give it at a moment, for a replay that moves forward in
 * time (`at` never goes back): sessions, given in join order, join it as they start and leave it
 * `slackMs` after they end (a kill is received a second or two after it happened); a player's later
 * session takes over their name. The name is the session's last, which is the list's but for a clan
 * tag changed during it.
 */
export function sessionSweep(
	sessions: readonly ListedSession[],
	slackMs = 10_000
): (at: number) => ReadonlyMap<string, string> {
	const listed = new Map<string, string>();
	const holding = new Map<string, number>();
	const ends = sessions
		.flatMap((s, i) => (s.leftAt ? [{ i, until: new Date(s.leftAt).getTime() + slackMs }] : []))
		.sort((a, b) => a.until - b.until);
	let joins = 0;
	let leaves = 0;
	return (at) => {
		for (; joins < sessions.length && new Date(sessions[joins].joinedAt).getTime() <= at; joins++) {
			listed.set(sessions[joins].steamId, sessions[joins].name);
			holding.set(sessions[joins].steamId, joins);
		}
		for (; leaves < ends.length && ends[leaves].until < at; leaves++) {
			const s = sessions[ends[leaves].i];
			if (holding.get(s.steamId) !== ends[leaves].i) continue;
			listed.delete(s.steamId);
			holding.delete(s.steamId);
		}
		return listed;
	};
}
