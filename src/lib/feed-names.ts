// How a Players search row shows the names the kill feed showed for a player that were not the
// ones the server listed them under: a few of them, the ones the search found first, then how many
// more. Pure and client-safe.

/** Up to `n` of a player's kill-feed names, those containing the search text first (`hit`). */
export function feedNamesLine(
	names: readonly string[],
	q: string,
	n = 3
): { names: { name: string; hit: boolean }[]; more: number } {
	const needle = q.trim().toLowerCase();
	const hit = (name: string) => !!needle && name.toLowerCase().includes(needle);
	const ordered = [...names.filter(hit), ...names.filter((name) => !hit(name))];
	return {
		names: ordered.slice(0, n).map((name) => ({ name, hit: hit(name) })),
		more: Math.max(0, names.length - n)
	};
}
