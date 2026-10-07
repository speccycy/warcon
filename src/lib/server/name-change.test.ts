import { describe, expect, test } from 'bun:test';
import {
	nameChangeStep,
	nameKey,
	namesShownElse,
	pruneNameTracks,
	readName,
	sessionSweep,
	validateNameChange,
	type NameTracks
} from './name-change';

const MIN = 60_000;
const p = (steamId: string, name: string) => ({ steamId, name });
/** The server's player list: SteamID to the name it lists them under. */
const list = (...players: [string, string][]) => new Map(players);

/**
 * Kill batches in turn, each the names the feed showed and the list of that moment, a minute
 * apart unless a batch says when; returns every batch's hits as [SteamID, verdict].
 */
function replay(
	config: Record<string, unknown>,
	batches: {
		shown: { steamId: string; name: string }[];
		listed: Map<string, string>;
		at?: number;
	}[]
) {
	const cfg = validateNameChange(config);
	const tracks: NameTracks = new Map();
	return batches.map((b, i) =>
		nameChangeStep(cfg, tracks, b.shown, b.listed, b.at ?? i * MIN).hits.map((h) => [
			h.player.steamId,
			h.verdict
		])
	);
}

describe('nameKey', () => {
	test('reads a name as it shows: case, spaces, invisible characters, look-alikes, I for l', () => {
		const key = nameKey('Silver Fox');
		expect(nameKey('silver  fox')).toBe(key);
		expect(nameKey('Silver\u200BFox')).toBe(key);
		// a Cyrillic o (U+043E) and a capital I passing for l
		expect(nameKey('SiIver F\u043Ex')).toBe(key);
		expect(nameKey('Ｓｉｌｖｅｒ Fox')).toBe(key);
		// punctuation added, a 1 or a | for the l, a 0 for an O, a filler that shows as nothing
		expect(nameKey('Silver_Fox.')).toBe(key);
		expect(nameKey('Si1ver Fox')).toBe(key);
		expect(nameKey('Si|ver Fox')).toBe(key);
		expect(nameKey('Silver Fox\u3164')).toBe(key);
		// symbols and emoji, and a dotless i
		expect(nameKey('~Silver Fox~')).toBe(key);
		expect(nameKey('Silver Fox \u{1F525}')).toBe(key);
		expect(nameKey('S\u0131lver Fox')).toBe(key);
		expect(nameKey('T0XIC')).toBe(nameKey('TOXIC'));
		expect(nameKey('Silver Fox2')).not.toBe(key);
		// a name of nothing but punctuation still reads as itself
		expect(nameKey('...')).toBe('...');
		expect(nameKey('...')).not.toBe(nameKey('___'));
	});
	test('reads a name without a clan tag in brackets, at the front or the back', () => {
		const core = readName('Silver Fox').core;
		for (const tagged of [
			'[ABC] Silver Fox',
			'Silver Fox [ABC]',
			'(ABC)Silver Fox',
			'【ABC】Silver Fox',
			'［ABC］ Silver Fox'
		])
			expect(readName(tagged).core).toBe(core);
		expect(readName('[ABC] Silver Fox').key).not.toBe(nameKey('Silver Fox'));
		// a name that is nothing but a tag reads as itself
		expect(readName('[ABC]').core).toBe(readName('[ABC]').key);
	});
});

describe('the name change step', () => {
	const listed = list(['1', 'Night Owl'], ['2', '[ABC] Wolfpack'], ['3', 'Ghostpepper']);

	test('a player shown under their own name, or their own with another clan tag, is no change', () => {
		const tracks: NameTracks = new Map();
		const { hits } = nameChangeStep(
			validateNameChange({}),
			tracks,
			[p('1', '[XYZ] Night Owl'), p('2', 'wolfpack'), p('2', '[DEF]Wolfpack'), p('1', 'Night Owl')],
			listed,
			0
		);
		expect(hits).toEqual([]);
		// and nothing is kept for them
		expect(tracks.size).toBe(0);
	});

	test('a player shown under another name has changed it; with only taken names counting, a free one does nothing', () => {
		const batch = [{ shown: [p('3', 'Charlie')], listed }];
		expect(replay({}, batch)).toEqual([[['3', 'shown as Charlie']]]);
		expect(replay({ takenOnly: true }, batch)).toEqual([[]]);
	});

	test("taking a listed player's name counts, look-alikes and a dropped clan tag no disguise", () => {
		const server = list(
			['1', 'Ghostpepper'],
			['2', '[R-14] ✪ Silver Fox'],
			['3', 'Tango'],
			['4', '[ABC] Golden Hawk']
		);
		expect(
			replay({ takenOnly: true }, [
				{
					shown: [p('1', '✪ SiIver Fox'), p('3', '[XYZ] Golden Hawk')],
					listed: server
				}
			])
		).toEqual([
			[
				// a tag swapped for another is another player's name, not this one's
				['1', 'shown as ✪ SiIver Fox, the name of 2']
			]
		]);
	});

	test('a short name matched only without the tags is too common to be a copy; the exact name is one', () => {
		const server = list(['1', 'Bob'], ['2', '[XYZ] Alex'], ['3', 'Sam']);
		expect(
			replay({ takenOnly: true }, [
				{ shown: [p('1', 'Alex'), p('3', '[XYZ] Alex')], listed: server }
			])
		).toEqual([[['3', 'shown as [XYZ] Alex, the name of 2']]]);
	});

	test('showing the same other name again is no new change, nor is going back to your own', () => {
		const at = (shown: string) => ({ shown: [p('3', shown)], listed });
		expect(
			replay({ changes: 2 }, [at('Charlie'), at('Charlie'), at('Ghostpepper'), at('Delta')])
		).toEqual([[], [], [], [['3', 'shown as Delta (2 changes in 10 min)']]]);
	});

	test('at N changes within the window the rule acts, then counts from nothing again', () => {
		const at = (shown: string) => ({ shown: [p('3', shown)], listed });
		expect(
			replay({ changes: 3, action: 'kick' }, [
				at('Alpha'),
				at('Bravo'),
				at('Charlie'),
				at('Delta'),
				at('Echo'),
				at('Foxtrot')
			])
		).toEqual([
			[],
			[],
			[['3', 'shown as Charlie (3 changes in 10 min)']],
			[],
			[],
			[['3', 'shown as Foxtrot (3 changes in 10 min)']]
		]);
	});

	test('changes older than the window fall out of the count', () => {
		const at = (shown: string, minute: number) => ({
			shown: [p('3', shown)],
			listed,
			at: minute * MIN
		});
		expect(replay({ changes: 2 }, [at('Alpha', 0), at('Bravo', 11), at('Charlie', 12)])).toEqual([
			[],
			[],
			[['3', 'shown as Charlie (2 changes in 10 min)']]
		]);
	});

	test('an alert rule tells staff about a player once a window; a kick rule acts at every count', () => {
		const at = (shown: string, minute: number) => ({
			shown: [p('3', shown)],
			listed,
			at: minute * MIN
		});
		const batches = [at('Alpha', 0), at('Bravo', 1), at('Charlie', 11)];
		// the change it did not tell staff about still counts while it is inside the window
		expect(replay({}, batches)).toEqual([
			[['3', 'shown as Alpha']],
			[],
			[['3', 'shown as Charlie (2 changes in 10 min)']]
		]);
		expect(replay({ action: 'kick' }, batches)).toEqual([
			[['3', 'shown as Alpha']],
			[['3', 'shown as Bravo']],
			[['3', 'shown as Charlie']]
		]);
	});

	test('a kicked player shown under the taken name again is a change again; one only flagged is not', () => {
		const cfg = validateNameChange({ action: 'kick', takenOnly: true });
		const server = list(['1', 'Ghostpepper'], ['2', 'Silver Fox']);
		const run = (kicked: (steamId: string) => boolean) => {
			const tracks: NameTracks = new Map();
			// kicked; still on (the kick has not landed) or back after it, under the taken name; then
			// back under their own and taking it again
			return ['Silver Fox', 'Silver Fox', 'Ghostpepper', 'Silver Fox'].map((name, i) =>
				nameChangeStep(cfg, tracks, [p('1', name)], server, i * MIN, { kicked }).hits.map(
					(h) => h.verdict
				)
			);
		};
		const taken = ['shown as Silver Fox, the name of 2'];
		expect(run(() => true)).toEqual([taken, taken, [], taken]);
		// a reserved slot a kick rule flags instead is flagged once for the name, again only after
		// going back to their own
		expect(run(() => false)).toEqual([taken, [], [], taken]);
	});

	test('two listed players with the same name, each shown under it, have not changed it', () => {
		const server = list(['1', 'Alex'], ['2', 'Alex'], ['3', '[ABC] Alex']);
		const shown = [p('1', 'Alex'), p('2', 'Alex'), p('3', 'Alex')];
		expect(replay({}, [{ shown, listed: server }])).toEqual([[]]);
		expect(replay({ takenOnly: true }, [{ shown, listed: server }])).toEqual([[]]);
	});

	test('a player off the list, or shown under a blank name, is not judged', () => {
		const tracks: NameTracks = new Map();
		const { hits } = nameChangeStep(
			validateNameChange({}),
			tracks,
			[p('9', 'Night Owl'), p('3', '  ')],
			listed,
			0
		);
		expect(hits).toEqual([]);
		expect(tracks.size).toBe(0);
	});

	test('the hit names who the player is listed as and who has the name they show', () => {
		const tracks: NameTracks = new Map();
		const { hits } = nameChangeStep(
			validateNameChange({}),
			tracks,
			[p('3', 'Night 0wl')],
			listed,
			0
		);
		expect(hits).toEqual([
			{
				player: p('3', 'Night 0wl'),
				listed: 'Ghostpepper',
				holder: '1',
				count: 1,
				verdict: 'shown as Night 0wl, the name of 1'
			}
		]);
	});

	test('undo puts the tracks back as they were before the batch', () => {
		const cfg = validateNameChange({ changes: 2 });
		const tracks: NameTracks = new Map();
		nameChangeStep(cfg, tracks, [p('3', 'Alpha')], listed, 0);
		const kept = structuredClone([...tracks]);
		const { hits, undo } = nameChangeStep(
			cfg,
			tracks,
			[p('3', 'Bravo'), p('1', 'Charlie')],
			listed,
			MIN
		);
		expect(hits.map((h) => h.player.steamId)).toEqual(['3']);
		undo();
		expect([...tracks]).toEqual(kept);
		// so the same batch, read again, acts again
		expect(
			nameChangeStep(cfg, tracks, [p('3', 'Bravo')], listed, MIN).hits.map((h) => h.verdict)
		).toEqual(['shown as Bravo (2 changes in 10 min)']);
	});

	test('pruning forgets the players the feed has not named within the window', () => {
		const cfg = validateNameChange({ windowMinutes: 5 });
		const tracks: NameTracks = new Map();
		nameChangeStep(cfg, tracks, [p('3', 'Alpha'), p('1', 'Bravo')], listed, 0);
		nameChangeStep(cfg, tracks, [p('1', 'Charlie')], listed, 4 * MIN);
		pruneNameTracks(cfg, tracks, 6 * MIN);
		expect([...tracks.keys()]).toEqual(['1']);
	});
});

describe('validateNameChange', () => {
	test('alert by default, counts clamped, a reason always set', () => {
		expect(validateNameChange({})).toEqual({
			takenOnly: false,
			changes: 1,
			windowMinutes: 10,
			action: 'alert',
			spareReserved: true,
			reason: 'Changing your name mid-game is not allowed here.'
		});
		expect(
			validateNameChange({ changes: 0, windowMinutes: 99999, action: 'ban', takenOnly: 1 })
		).toMatchObject({ changes: 1, windowMinutes: 120, action: 'alert', takenOnly: true });
	});
});

describe('the names a batch showed that were not the listed ones', () => {
	const server = list(['1', 'Ghostpepper'], ['2', '[R-14] ✪ Silver Fox'], ['3', '[ABC] Steady']);

	test("each player's other name once, with the listed player whose name it read as", () => {
		expect(
			namesShownElse(
				[
					p('1', '✪ SiIver Fox'),
					p('1', '✪ SiIver Fox'),
					p('1', 'Tango'),
					// their own name with another clan tag, a player off the list, a blank name
					p('3', '[XYZ] Steady'),
					p('9', 'Silver Fox'),
					p('2', '  ')
				],
				server
			)
		).toEqual([
			{ steamId: '1', name: '✪ SiIver Fox', holder: '2' },
			{ steamId: '1', name: 'Tango', holder: null }
		]);
	});
});

describe('the list as the sessions give it', () => {
	test('sessions join in order and leave some seconds after they end; a later session takes over', () => {
		const at = (s: number) => new Date(s * 1000);
		const listedAt = sessionSweep(
			[
				{ steamId: '1', name: 'Alpha', joinedAt: at(0), leftAt: at(100) },
				{ steamId: '2', name: 'Bravo', joinedAt: at(10), leftAt: null },
				{ steamId: '1', name: 'Alpha2', joinedAt: at(105), leftAt: at(200) }
			],
			10_000
		);
		expect([...listedAt(5_000)]).toEqual([['1', 'Alpha']]);
		expect([...listedAt(50_000)]).toEqual([
			['1', 'Alpha'],
			['2', 'Bravo']
		]);
		// ended at 100 s, still listed for the slack, then the next session holds the name
		expect(listedAt(104_000).get('1')).toBe('Alpha');
		expect(listedAt(106_000).get('1')).toBe('Alpha2');
		// the first session's end does not take the second one off
		expect(listedAt(150_000).get('1')).toBe('Alpha2');
		expect(listedAt(211_000).has('1')).toBe(false);
		expect(listedAt(211_000).get('2')).toBe('Bravo');
	});
});
