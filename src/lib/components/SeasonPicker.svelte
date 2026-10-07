<script lang="ts">
	// What a board shows: "Showing <Season 2> ▾", a menu of the official seasons, the
	// organisation's own and the rolling ranges. Only seasons that have started are offered; the
	// one showing is marked. Any pick closes it, and so does a click outside or Escape.
	import Badge from '$lib/components/Badge.svelte';
	import { BOARD_RANGES, type BoardWhen } from '$lib/leaderboard';
	import { isFinished, seasonSpan, type Season } from '$lib/seasons';

	let {
		when,
		seasons,
		orgName = '',
		disabled = false,
		onpick
	}: {
		when: BoardWhen;
		/** started seasons, newest first */
		seasons: Season[];
		orgName?: string;
		disabled?: boolean;
		onpick: (range: BoardWhen['range']) => void;
	} = $props();

	let open = $state(false);
	let wrap: HTMLDivElement;
	const now = Date.now();
	let groups = $derived(
		[
			{ label: 'Official seasons', list: seasons.filter((s) => s.kind === 'official') },
			{
				label: orgName ? `${orgName} seasons` : 'Our seasons',
				list: seasons.filter((s) => s.kind === 'custom')
			}
		].filter((g) => g.list.length)
	);
	let showing = $derived(
		when.season?.name ?? BOARD_RANGES.find((r) => r.key === when.range)?.label ?? 'All time'
	);
	function pick(range: BoardWhen['range']) {
		open = false;
		if (range !== when.range) onpick(range);
	}
</script>

<svelte:window
	onclick={(e) => {
		if (!wrap.contains(e.target as Node)) open = false;
	}}
	onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

<div class="relative flex items-center gap-2" bind:this={wrap}>
	<span class="caps text-mist-400">Showing</span>
	<button
		type="button"
		class="btn min-w-[200px] justify-between normal-case {open ? 'bg-ink-700' : ''}"
		aria-haspopup="menu"
		aria-expanded={open}
		{disabled}
		onclick={() => (open = !open)}
		><span class="truncate text-[13.5px] font-medium tracking-normal">{showing}</span><span
			class="text-[10px] text-accent"
			aria-hidden="true">▼</span
		></button
	>
	{#if open}
		<div
			class="menu right-0 left-auto max-sm:left-3 sm:w-[320px]"
			role="menu"
			aria-label="Seasons and ranges"
		>
			{#each groups as g (g.label)}
				<span class="block px-3 pt-2.5 pb-1 caps text-mist-400">{g.label}</span>
				{#each g.list as s (s.key)}
					{@const on = when.range === `s:${s.key}`}
					<button
						type="button"
						role="menuitemradio"
						aria-checked={on}
						class="menu-item {on ? 'border-accent! bg-ink-800' : ''}"
						onclick={() => pick(`s:${s.key}`)}
					>
						<span class="truncate">{s.name}</span>
						{#if !isFinished(s, now)}<Badge tone="ok">Live</Badge>{/if}
						<span class="ml-auto shrink-0 text-[12px] text-mist-400 tabular"
							>{seasonSpan(s, now, true)}</span
						>
					</button>
				{/each}
				<div class="mx-1 my-1.5 h-px bg-white/[0.06]"></div>
			{/each}
			<span class="block px-3 pt-2.5 pb-1 caps text-mist-400">Ranges</span>
			{#each BOARD_RANGES as r (r.key)}
				{@const on = when.range === r.key}
				<button
					type="button"
					role="menuitemradio"
					aria-checked={on}
					class="menu-item {on ? 'border-accent! bg-ink-800' : ''}"
					onclick={() => pick(r.key)}>{r.label}</button
				>
			{/each}
		</div>
	{/if}
</div>
