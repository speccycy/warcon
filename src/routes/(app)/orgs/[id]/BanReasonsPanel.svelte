<script lang="ts">
	// The org's quick reasons on the Ban list page: a closed strip naming them, which opens (for
	// owners) into a row per button, its short name, the reason it fills in and the length it sets,
	// saved together. Ban list editors who are not owners see them read-only.
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import RowMenu from '$lib/components/RowMenu.svelte';
	import {
		BAN_REASON_DAYS,
		banReasonsProblem,
		cleanBanReason,
		DEFAULT_BAN_REASONS,
		lengthLabel,
		MAX_BAN_REASON,
		MAX_BAN_REASON_LABEL,
		MAX_BAN_REASONS,
		type BanReason
	} from '$lib/ban-reasons';

	let {
		org,
		reasons,
		owner
	}: { org: { id: string; name: string }; reasons: BanReason[]; owner: boolean } = $props();

	/** One row as edited; the length as its select holds it, '' for not set. */
	type Row = { key: number; label: string; reason: string; days: string };
	let nextKey = 0;
	const rowsOf = (list: BanReason[]): Row[] =>
		list.map((r) => ({
			key: nextKey++,
			label: r.label,
			reason: r.reason,
			days: r.days === null ? '' : String(r.days)
		}));

	let open = $state(false);
	let busy = $state(false);
	let rows = $state<Row[]>(untrack(() => rowsOf(reasons)));
	// Back to what is saved when that changes, not whenever the page reloads its data (a sync or an
	// unban elsewhere on the page), which would throw away what is being typed.
	let shown = untrack(() => JSON.stringify(reasons));
	$effect(() => {
		const now = JSON.stringify(reasons);
		if (now === shown) return;
		shown = now;
		rows = rowsOf(reasons);
	});

	/** What Save sends: rows left wholly blank are dropped. */
	let draft = $derived(
		rows
			.filter((r) => r.label.trim() || r.reason.trim())
			.map((r) =>
				cleanBanReason({
					label: r.label,
					reason: r.reason,
					days: r.days === '' ? null : Number(r.days)
				})
			)
	);
	let problem = $derived(banReasonsProblem(draft));
	let changed = $derived(JSON.stringify(draft) !== JSON.stringify(reasons));
	let builtIn = $derived(JSON.stringify(reasons) === JSON.stringify(DEFAULT_BAN_REASONS));

	function move(i: number, by: number) {
		if (i + by < 0 || i + by >= rows.length) return;
		const list = [...rows];
		[list[i], list[i + by]] = [list[i + by], list[i]];
		rows = list;
	}
	const add = () => (rows = [...rows, { key: nextKey++, label: '', reason: '', days: '' }]);
	const remove = (i: number) => (rows = rows.filter((_, j) => j !== i));

	async function save(value: BanReason[] | null) {
		busy = true;
		try {
			await api('PATCH', `/api/orgs/${encodeURIComponent(org.id)}`, { banReasons: value });
			toast(value ? 'Quick reasons saved.' : 'Quick reasons back to the built-in six.', 'ok');
			await invalidateAll();
			open = false;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function reset() {
		if (
			!(await confirmDialog(
				`Put back the built-in six quick reasons? ${org.name}'s own are removed; bans already placed keep their reasons.`,
				{ okLabel: 'Put them back' }
			))
		)
			return;
		await save(null);
	}

	const GRID = 'grid-cols-[minmax(0,1fr)_116px_32px] sm:grid-cols-[200px_minmax(0,1fr)_168px_32px]';
</script>

<div class="mb-4 panel px-4 py-3.5 sm:px-5">
	<button
		type="button"
		class="flex min-h-6 w-full cursor-pointer items-center gap-3 text-left"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="caps whitespace-nowrap text-mist-400">Quick reasons</span>
		<span class="min-w-0 flex-1 truncate text-[12.5px] text-mist-600"
			>{open ? '' : reasons.map((r) => r.label).join(' · ') || 'none'}</span
		>
		<span class="inline-flex items-center gap-1.5 caps text-mist-400">
			{open ? 'Close' : owner ? 'Edit' : 'Show'}
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg
			>
		</span>
	</button>

	{#if open}
		<p class="note mt-3.5 mb-4 max-w-[900px]">
			The buttons under Reason when anyone in {org.name} places a ban. A button fills in its reason and,
			when it has a length, sets Expires; with no length set, Expires stays as the admin has it. Everyone
			who can open a server sees a ban's reason, so write it as something the player could be told.
			{#if !owner}Only an owner of the organisation can change them.{/if}
		</p>

		{#if owner}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void save(draft);
				}}
			>
				{#if rows.length}
					<div class="grid {GRID} gap-2">
						<span class="field-label mb-0!">Short name</span>
						<span class="field-label mb-0! hidden sm:block">Reason</span>
						<span class="field-label mb-0!">Length</span>
						<span></span>
					</div>
				{/if}
				{#each rows as row, i (row.key)}
					<div
						class="grid {GRID} items-center gap-2 border-t border-white/5 py-3 sm:border-0 sm:py-0 sm:pt-2"
					>
						<input
							class="input"
							type="text"
							aria-label="Short name"
							maxlength={MAX_BAN_REASON_LABEL}
							bind:value={row.label}
						/>
						<input
							class="order-last col-span-3 input sm:order-none sm:col-span-1"
							type="text"
							aria-label="Reason"
							placeholder="Reason"
							maxlength={MAX_BAN_REASON}
							bind:value={row.reason}
						/>
						<select class="input" aria-label="Length" bind:value={row.days}>
							<option value="">{lengthLabel(null)}</option>
							{#each BAN_REASON_DAYS as d (d)}
								<option value={String(d)}>{lengthLabel(d)}</option>
							{/each}
						</select>
						<RowMenu label="Actions for {row.label || 'this quick reason'}">
							{#if i > 0}
								<button type="button" class="menu-item" role="menuitem" onclick={() => move(i, -1)}
									>Move up</button
								>
							{/if}
							{#if i < rows.length - 1}
								<button type="button" class="menu-item" role="menuitem" onclick={() => move(i, 1)}
									>Move down</button
								>
							{/if}
							{#if rows.length > 1}<hr class="my-1 border-black" />{/if}
							<button
								type="button"
								class="menu-item text-danger!"
								role="menuitem"
								onclick={() => remove(i)}>Remove</button
							>
						</RowMenu>
					</div>
				{/each}
				<button
					type="button"
					class="mt-3 btn btn-sm"
					disabled={rows.length >= MAX_BAN_REASONS}
					onclick={add}>+ Add a quick reason</button
				>
				<div class="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3.5">
					<span class="text-[12.5px] {problem ? 'text-danger' : 'text-mist-400'}"
						>{problem || `${draft.length} of ${MAX_BAN_REASONS}`}</span
					>
					<span class="ml-auto inline-flex flex-wrap justify-end gap-2">
						<button type="button" class="btn btn-ghost" disabled={busy || builtIn} onclick={reset}
							>Reset to the built-in six</button
						>
						<button type="submit" class="btn btn-primary" disabled={busy || !!problem || !changed}
							>Save</button
						>
					</span>
				</div>
			</form>
		{:else if reasons.length}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Short name</th><th>Reason</th><th>Length</th></tr>
					</thead>
					<tbody>
						{#each reasons as r (r.label)}
							<tr>
								<td class="whitespace-nowrap">{r.label}</td>
								<td>{r.reason}</td>
								<td class="whitespace-nowrap text-mist-400">{lengthLabel(r.days)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="text-[13px] text-mist-600">No quick reasons: the ban dialog offers none.</p>
		{/if}
	{/if}
</div>
