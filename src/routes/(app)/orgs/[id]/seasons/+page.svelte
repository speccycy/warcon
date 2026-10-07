<script lang="ts">
	// The organisation's seasons: what its boards open on, the columns its public boards show, the
	// official seasons (Warcon's list), and its own, each running until the next one starts. A
	// season that has not begun can be moved or deleted; one that has keeps its start, so its
	// standings never move.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import BoardColumnsPanel from '../BoardColumnsPanel.svelte';
	import {
		BOARD_OPENS,
		currentSeason,
		isFinished,
		isStarted,
		seasonDay,
		seasonSpan,
		WINNER_MIN_MATCHES,
		type BoardOpens,
		type Season
	} from '$lib/seasons';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);
	const now = Date.now();
	let official = $derived(data.seasons.filter((s) => s.kind === 'official').reverse());
	let own = $derived(data.seasons.filter((s) => s.kind === 'custom').reverse());
	let ourCurrent = $derived(currentSeason(data.seasons, 'custom', now));
	let officialCurrent = $derived(currentSeason(data.seasons, 'official', now));

	/** What each choice opens on today. */
	const today = (key: BoardOpens): string => {
		if (key === 'official') return officialCurrent ? `${officialCurrent.name} now` : 'none running';
		if (key === 'custom')
			return ourCurrent
				? `${ourCurrent.name} now`
				: `none running: ${officialCurrent?.name ?? 'all time'} until one starts`;
		return key === '30d' ? 'a rolling range' : 'no season';
	};
	const status = (s: Season) =>
		!isStarted(s, now) ? 'Scheduled' : isFinished(s, now) ? 'Finished' : 'Live';
	const TONE = { Scheduled: 'info', Live: 'ok', Finished: '' } as const;

	/** The first UTC day a new season can start on: tomorrow. */
	const minDay = new Date(Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000)
		.toISOString()
		.slice(0, 10);
	const startOf = (day: string) => `${day}T00:00:00.000Z`;

	let busy = $state(false);
	async function run(fn: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await fn();
			toast(done, 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	function setOpens(key: BoardOpens) {
		if (key === data.opens) return;
		void run(() => api('PATCH', orgPath, { boardOpens: key }), 'Boards open on that from now on.');
	}

	let name = $state('');
	let day = $state('');
	function add() {
		const n = name.trim();
		void run(async () => {
			await api('POST', `${orgPath}/seasons`, { name: n, startsAt: startOf(day) });
			name = '';
			day = '';
		}, `${n} added.`);
	}

	let editing = $state<{ season: Season; name: string; day: string } | null>(null);
	function save() {
		const e = editing;
		if (!e) return;
		const body: Record<string, string> = { name: e.name.trim() };
		if (!isStarted(e.season, Date.now()) && e.day !== e.season.startsAt.slice(0, 10))
			body.startsAt = startOf(e.day);
		void run(async () => {
			await api('PATCH', `${orgPath}/seasons/${encodeURIComponent(e.season.key)}`, body);
			editing = null;
		}, 'Season saved.');
	}
	async function remove(s: Season) {
		if (!(await confirmDialog(`Delete ${s.name}?`, { okLabel: 'Delete', danger: true }))) return;
		await run(
			() => api('DELETE', `${orgPath}/seasons/${encodeURIComponent(s.key)}`),
			`${s.name} deleted.`
		);
	}
</script>

<div class="space-y-5">
	<div class="panel">
		<span class="label-sm">Boards open on</span>
		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
			{#each BOARD_OPENS as o (o.key)}
				<label
					class="flex cursor-pointer items-start gap-2.5 rounded-ctl border bg-ink-950 px-3.5 py-3 {data.opens ===
					o.key
						? 'border-accent'
						: 'border-black'}"
				>
					<input
						type="radio"
						name="opens"
						class="mt-1 accent-accent"
						checked={data.opens === o.key}
						disabled={busy}
						onchange={() => setOpens(o.key)}
					/>
					<span>
						<span class="block text-[13.5px]">{o.label}</span>
						<span class="block text-[12px] text-mist-400">{today(o.key)}</span>
					</span>
				</label>
			{/each}
		</div>
		<p class="note">
			For {data.org.name}'s leaderboards, in the panel and on the public pages. Anyone looking can
			still pick another season or range on the board.
		</p>
	</div>

	<BoardColumnsPanel org={data.org} hidden={data.hidden} />

	<div class="panel">
		<span class="label-sm">Official seasons</span>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Season</th><th>Dates</th><th></th></tr></thead>
				<tbody>
					{#each official as s (s.key)}
						<tr>
							<td>{s.name}</td>
							<td class="whitespace-nowrap">{seasonSpan(s, now)}</td>
							<td><Badge tone={TONE[status(s)]}>{status(s)}</Badge></td>
						</tr>
					{:else}
						<tr><td colspan="3" class="py-4 text-center text-mist-600">None yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			Bulkhead's seasons, the same for every community, each from the moment it launched. Warcon
			adds each one when it is announced; they can't be changed here.
		</p>
	</div>

	<div class="panel">
		<span class="label-sm">{data.org.name} seasons</span>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Name</th><th>Starts</th><th></th><th></th></tr></thead>
				<tbody>
					{#each own as s (s.key)}
						<tr>
							<td>{s.name}</td>
							<td class="whitespace-nowrap">{seasonDay(s.startsAt)}</td>
							<td><Badge tone={TONE[status(s)]}>{status(s)}</Badge></td>
							<td class="text-right whitespace-nowrap">
								<button
									class="btn btn-sm"
									disabled={busy}
									onclick={() =>
										(editing = { season: s, name: s.name, day: s.startsAt.slice(0, 10) })}
									>{isStarted(s, now) ? 'Rename' : 'Edit'}</button
								>
								{#if !isStarted(s, now)}
									<button class="btn btn-sm btn-danger" disabled={busy} onclick={() => remove(s)}
										>Delete</button
									>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="4" class="py-4 text-center text-mist-600">No seasons of your own yet.</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<form
			class="mt-3 flex flex-wrap items-end gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				add();
			}}
		>
			<label class="block min-w-[200px] flex-1 sm:max-w-[320px]"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={name}
					maxlength="40"
					placeholder="November league"
					required
				/></label
			>
			<label class="block"
				><span class="field-label">Starts on</span><input
					class="input"
					type="date"
					bind:value={day}
					min={minDay}
					required
				/></label
			>
			<button type="submit" class="btn btn-primary" disabled={busy}>Add season</button>
		</form>
		<p class="note">
			A season runs until your next one starts, from midnight UTC. Once it has started its start
			date is fixed, so finished standings stay put. To end one early, start the next.
		</p>
	</div>

	<div class="panel">
		<span class="label-sm">Winners</span>
		<p class="text-[13.5px] leading-relaxed">
			When a season ends, its top three on kills, K/D (at least {WINNER_MIN_MATCHES} matches), playtime
			and wins show on its board and on those players' pages, for official seasons and yours alike.
		</p>
	</div>
</div>

{#if editing}
	<Modal
		title={isStarted(editing.season, now) ? 'Rename season' : 'Edit season'}
		onclose={() => (editing = null)}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={editing.name}
					maxlength="40"
					required
				/></label
			>
			{#if !isStarted(editing.season, now)}
				<label class="block"
					><span class="field-label">Starts on</span><input
						class="input"
						type="date"
						bind:value={editing.day}
						min={minDay}
						required
					/></label
				>
			{/if}
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (editing = null)}>Cancel</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
			</div>
		</form>
	</Modal>
{/if}
