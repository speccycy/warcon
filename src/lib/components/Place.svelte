<script lang="ts">
	// A season place, 1 to 3: brass, then light and dark grey.
	let { n, small = false }: { n: number; small?: boolean } = $props();
	const TONES = ['bg-accent text-ink-950', 'bg-mist-400 text-ink-950', 'bg-mist-600 text-mist-100'];
</script>

<span
	class="inline-flex shrink-0 items-center justify-center rounded-ctl font-display leading-none font-semibold {small
		? 'size-[18px] text-[11.5px]'
		: 'size-[22px] text-[13px]'} {TONES[n - 1] ?? TONES[2]}">{n}</span
>
