import { describe, expect, test } from 'bun:test';
import {
	abandoned,
	awardsFor,
	durationOf,
	matchTeams,
	perMinute,
	type MatchLine,
	type MatchView
} from './matches';

const line = (steamId: string, extra: Partial<MatchLine> = {}): MatchLine => ({
	steamId,
	name: steamId,
	faction: 'Valkyra',
	seconds: 3600,
	kills: 0,
	deaths: 0,
	cashDelta: 0,
	headshots: 0,
	teamKills: 0,
	suicides: 0,
	vehicleKills: 0,
	longestM: null,
	killStreak: 0,
	deathStreak: 0,
	result: 'win',
	...extra
});

describe('awards', () => {
	const lines = [
		line('a', { kills: 31, deaths: 5, longestM: 120, killStreak: 9, cashDelta: 4000 }),
		line('b', { kills: 12, deaths: 1, longestM: 412, killStreak: 4, cashDelta: 12_400 }),
		line('c', { kills: 9, deaths: 0, longestM: 40, killStreak: 2, cashDelta: -300 })
	];

	test('the five, judged as the page says', () => {
		expect(awardsFor(lines, 3600).map((a) => [a.key, a.steamId, a.value])).toEqual([
			['kills', 'a', '31'],
			['kd', 'b', '12.00'],
			['longest', 'b', '412 m'],
			['streak', 'a', '9'],
			['cash', 'b', '+$12,400']
		]);
	});

	test('none for a short match, and only what was earned', () => {
		expect(awardsFor(lines, 19 * 60)).toEqual([]);
		const quiet = [line('a', { kills: 2, killStreak: 2 }), line('b', { cashDelta: -50 })];
		expect(awardsFor(quiet, 3600).map((a) => a.key)).toEqual(['kills']);
		expect(awardsFor([], 3600)).toEqual([]);
	});
});

describe('a match', () => {
	test('is abandoned when it ended without scores', () => {
		expect(abandoned({ endedAt: '2026-09-22T13:00:00Z', finalScores: null })).toBe(true);
		expect(abandoned({ endedAt: '2026-09-22T13:00:00Z', finalScores: [] })).toBe(true);
		expect(
			abandoned({ endedAt: '2026-09-22T13:00:00Z', finalScores: [{ name: 'Valkyra', score: 100 }] })
		).toBe(false);
		expect(abandoned({ endedAt: null, finalScores: null })).toBe(false);
	});

	test('lasts from its start to its end, or to now', () => {
		expect(durationOf({ startedAt: '2026-09-22T13:00:00Z', endedAt: '2026-09-22T14:30:00Z' })).toBe(
			5400
		);
		expect(
			durationOf(
				{ startedAt: '2026-09-22T13:00:00Z', endedAt: null },
				Date.parse('2026-09-22T13:10:00Z')
			)
		).toBe(600);
	});

	test('kills per minute needs time on', () => {
		expect(perMinute(30, 1800)).toBe(1);
		expect(perMinute(3, 0)).toBeNull();
	});
});

describe('the scoreboard by side', () => {
	const view = (
		finalScores: { name: string; score: number }[] | null,
		factions = ['Valkyra', 'Manticore', 'Lonestar']
	): Pick<MatchView, 'match' | 'factions'> => ({
		match: {
			id: 1,
			startedAt: '2026-10-06T10:00:00Z',
			endedAt: '2026-10-06T11:00:00Z',
			map: 'Ozeti',
			experiences: null,
			lighting: null,
			peakPlayers: 6,
			players: 6,
			finalScores,
			winner: finalScores?.length ? finalScores[0].name : null
		},
		factions: factions.map((name) => ({ name, colorHex: null }))
	});
	const lines = [
		line('a', { faction: 'Lonestar', result: 'loss' }),
		line('b', { faction: 'Valkyra', result: 'win' }),
		line('c', { faction: null, result: null }),
		line('d', { faction: 'Manticore', result: 'loss' }),
		line('e', { faction: 'Valkyra', result: 'win' }),
		line('f', { faction: 'Lonestar', result: 'loss' })
	];
	const shape = (teams: ReturnType<typeof matchTeams>) =>
		teams.map((t) => [t.name, t.result, t.lines.map((l) => l.steamId).join('')]);

	test('the sides by final score, each in the order it was given, then the unassigned', () => {
		const scores = [
			{ name: 'Lonestar', score: 55 },
			{ name: 'Valkyra', score: 100 },
			{ name: 'Manticore', score: 61 }
		];
		expect(shape(matchTeams(view(scores), lines))).toEqual([
			['Valkyra', 'win', 'be'],
			['Manticore', 'loss', 'd'],
			['Lonestar', 'loss', 'af'],
			[null, null, 'c']
		]);
	});

	test('scoreboard order without scores; a side nobody ended on is left out, one off the board follows', () => {
		const odd = [
			...lines.filter((l) => l.faction !== 'Manticore'),
			line('g', { faction: 'White' })
		];
		expect(shape(matchTeams(view(null, ['Lonestar', 'Valkyra', 'Manticore']), odd))).toEqual([
			['Lonestar', 'loss', 'af'],
			['Valkyra', 'win', 'be'],
			['White', 'win', 'g'],
			[null, null, 'c']
		]);
		expect(matchTeams(view(null), [])).toEqual([]);
	});
});
