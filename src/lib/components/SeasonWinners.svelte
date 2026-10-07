<script lang="ts">
	// A finished season's top three in each category, above its final board; each name opens the
	// player's page.
	import { fmtMinutes, fmtNum } from '$lib/format';
	import {
		WINNER_CATEGORIES,
		WINNER_MIN_MATCHES,
		type SeasonWinners,
		type WinnerCategory
	} from '$lib/seasons';
	import Place from '$lib/components/Place.svelte';

	let { winners, hrefFor }: { winners: SeasonWinners; hrefFor: (steamId: string) => string } =
		$props();

	const value = (category: WinnerCategory, v: number) =>
		category === 'kd'
			? v.toFixed(2)
			: category === 'playtime'
				? fmtMinutes(Math.round(v))
				: fmtNum(v);
</script>

<span class="mb-2 block caps text-mist-400">Winners</span>
<div class="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
	{#each WINNER_CATEGORIES as c (c.key)}
		<div class="min-w-0 rounded-ctl border border-black bg-ink-950 px-4 pt-3.5 pb-2">
			<div class="mb-1 caps text-mist-400">
				{c.label}{#if c.key === 'kd'}<span class="tracking-normal text-mist-600 normal-case">
						· at least {WINNER_MIN_MATCHES} matches</span
					>{/if}
			</div>
			{#each winners[c.key] as w, i (w.steamId)}
				<div
					class="flex items-center gap-2.5 border-b border-white/5 py-[7px] text-[13.5px] last:border-0"
				>
					<Place n={i + 1} />
					<a
						href={hrefFor(w.steamId)}
						data-sveltekit-preload-data="tap"
						class="min-w-0 truncate hover:text-accent">{w.name}</a
					>
					<span class="ml-auto font-display text-base font-semibold tracking-[0.04em] tabular"
						>{value(c.key, w.value)}</span
					>
				</div>
			{:else}
				<div class="py-[7px] text-[13px] text-mist-600">Nobody qualified.</div>
			{/each}
		</div>
	{/each}
</div>
