<script lang="ts">
	// The columns the organisation's public boards show, on its Seasons tab: a box per column of
	// the board (kills always shown), the header row visitors will see, saved together. The panel's
	// own board, its export and the public JSON keep every column.
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { BOARD_COLUMNS, FIXED_COLUMN, type BoardColumn } from '$lib/leaderboard';

	let { org, hidden }: { org: { id: string; name: string }; hidden: BoardColumn[] } = $props();

	/** the columns left out as ticked here, in the table's order */
	let off = $state<BoardColumn[]>(untrack(() => [...hidden]));
	// Back to what is saved when that changes, not whenever the page reloads its data.
	let saved = untrack(() => hidden.join());
	$effect(() => {
		const now = hidden.join();
		if (now === saved) return;
		saved = now;
		off = [...hidden];
	});
	let changed = $derived(off.join() !== hidden.join());
	let visible = $derived(BOARD_COLUMNS.filter((c) => !off.includes(c.key)));
	let busy = $state(false);

	function toggle(key: BoardColumn) {
		const next = off.includes(key) ? off.filter((k) => k !== key) : [...off, key];
		off = BOARD_COLUMNS.filter((c) => next.includes(c.key)).map((c) => c.key);
	}

	async function save() {
		busy = true;
		try {
			await api('PATCH', `/api/orgs/${encodeURIComponent(org.id)}`, { boardHidden: off });
			toast(off.length ? 'Public board columns saved.' : 'Public boards show every column.', 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="panel">
	<span class="label-sm">Public board columns</span>
	<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
		{#each BOARD_COLUMNS as c (c.key)}
			{@const fixed = c.key === FIXED_COLUMN}
			{@const on = fixed || !off.includes(c.key)}
			<label
				class="flex min-h-11 items-center gap-2.5 rounded-ctl border border-black bg-ink-950 px-3 text-[13.5px] {on &&
				!fixed
					? ''
					: 'text-mist-400'} {fixed ? '' : 'cursor-pointer'}"
			>
				<input
					type="checkbox"
					class="accent-accent"
					checked={on}
					disabled={fixed || busy}
					onchange={() => toggle(c.key)}
				/>
				<span>{fixed ? `${c.label}, always shown` : c.label}</span>
				<span class="ml-auto caps text-mist-600" aria-hidden="true">{c.head}</span>
			</label>
		{/each}
	</div>
	<span class="mt-4 mb-2 block caps text-mist-400">Visitors see</span>
	<div class="table-wrap">
		<table aria-label="The header row visitors will see">
			<thead>
				<tr>
					<th class="num">#</th>
					<th>Player</th>
					{#each visible as c (c.key)}
						<th class={c.key === 'lastSeen' ? '' : 'num'}>{c.head}</th>
					{/each}
				</tr>
			</thead>
		</table>
	</div>
	<div class="mt-3.5 flex flex-wrap gap-2">
		<button type="button" class="btn btn-primary" disabled={!changed || busy} onclick={save}
			>Save columns</button
		>
		<button type="button" class="btn" disabled={!off.length || busy} onclick={() => (off = [])}
			>Show every column</button
		>
	</div>
	<p class="note">
		For {org.name}'s public boards, each server's and the organisation's. Rank, player and kills
		always show. The panel's Leaderboards tab and its CSV export keep every column and the board's
		JSON keeps every number, so leaving a column out tidies the page without hiding anything.
	</p>
</div>
