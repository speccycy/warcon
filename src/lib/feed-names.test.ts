import { describe, expect, test } from 'bun:test';
import { feedNamesLine } from './feed-names';

describe('a search row’s kill-feed names', () => {
	const names = ['Halcyon', 'Silver Fox', 'Orchid', 'Silverback', 'Tango'];

	test('the ones the search found first, then the newest, and how many more', () => {
		expect(feedNamesLine(names, 'silver')).toEqual({
			names: [
				{ name: 'Silver Fox', hit: true },
				{ name: 'Silverback', hit: true },
				{ name: 'Halcyon', hit: false }
			],
			more: 2
		});
	});

	test('without a search, the newest few; a short list, all of it', () => {
		expect(feedNamesLine(names, '  ').names.map((n) => n.name)).toEqual([
			'Halcyon',
			'Silver Fox',
			'Orchid'
		]);
		expect(feedNamesLine(['Tango'], 'x')).toEqual({
			names: [{ name: 'Tango', hit: false }],
			more: 0
		});
	});
});
