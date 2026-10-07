<script lang="ts">
	// A player's career: the places they won in finished seasons, rank, streak, results overall,
	// the scoreboard totals, season by season, by map and by faction, and the last ten matches.
	// Shared by the dossier's Career section and the public career page; `matchHref` says where a
	// match's name goes (its page here or on the public site), `seasonHref` where a season's goes
	// (its board).
	import type { Snippet } from 'svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Place from '$lib/components/Place.svelte';
	import { fmtCash } from '$lib/cash';
	import { fmtNum, fmtTime, mapName } from '$lib/format';
	import { kdRatio, type CareerMatch, type CareerView } from '$lib/leaderboard';
	import { fmtLength, perMinute } from '$lib/matches';
	import {
		isFinished,
		WINNER_CATEGORIES,
		WINNER_MIN_MATCHES,
		type Season,
		type WinnerCategory
	} from '$lib/seasons';

	let {
		career,
		serverName,
		orgName,
		/** more than one server in the org: name the server on each match */
		multiServer = false,
		matchHref,
		seasonHref,
		/** rendered between the season table and the tables (the public career puts combat here) */
		children
	}: {
		career: CareerView;
		serverName: string;
		orgName: string;
		multiServer?: boolean;
		matchHref?: (m: CareerMatch) => string;
		seasonHref?: (s: Season) => string;
		children?: Snippet;
	} = $props();

	const kd = (k: number, d: number) => {
		const v = kdRatio(k, d);
		return v === null ? '—' : v.toFixed(2);
	};
	const rank = (n: number | null) => (n === null ? '—' : `#${fmtNum(n)}`);
	const pct = (part: number, whole: number) =>
		whole && part ? `${Math.round((part / whole) * 100)}%` : '—';
	const kpm = (kills: number, minutes: number) => {
		const v = perMinute(kills, minutes * 60);
		return v === null ? '—' : v.toFixed(2);
	};
	const RESULT_TONE = { win: 'text-ok', loss: 'text-danger', draw: 'text-mist-400' } as const;
	const RESULT_LABEL = { win: 'Win', loss: 'Loss', draw: 'Draw' } as const;
	const cash = (n: number) => `${n > 0 ? '+' : ''}${fmtCash(n)}`;
	const now = Date.now();
	const CATEGORY = Object.fromEntries(WINNER_CATEGORIES.map((c) => [c.key, c.label])) as Record<
		WinnerCategory,
		string
	>;
	let places = $derived(
		career.seasons.flatMap((s) =>
			s.places.map((p) => ({ ...p, season: s.season, key: `${s.season.key}:${p.category}` }))
		)
	);
</script>

{#if places.length}
	<div class="mb-4 flex flex-wrap gap-2" aria-label="Places won">
		{#each places as p (p.key)}
			<svelte:element
				this={seasonHref ? 'a' : 'span'}
				href={seasonHref?.(p.season)}
				class="inline-flex h-[30px] items-center gap-2 rounded-ctl border border-black bg-ink-800 pr-3 pl-1 text-[13px] whitespace-nowrap {seasonHref
					? 'hover:text-accent'
					: ''}"
				><Place n={p.place} />{CATEGORY[p.category]}<span class="text-mist-400"
					>· {p.season.name}</span
				></svelte:element
			>
		{/each}
	</div>
{/if}

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
	{#each [['Rank here', rank(career.rank.server)], [`Rank, all ${orgName} servers`, rank(career.rank.org)], ['Streak', career.streak ? `${career.streak.n} ${career.streak.kind === 'win' ? 'win' : 'loss'}${career.streak.n === 1 ? '' : career.streak.kind === 'win' ? 's' : 'es'}` : '—'], ['Matches', `${fmtNum(career.matches)} · ${career.wins}-${career.losses}-${career.draws}`], ['K/D', `${kd(career.kills, career.deaths)} · ${fmtNum(career.kills)} / ${fmtNum(career.deaths)}`], ['Kills per minute', kpm(career.kills, career.minutes)], ['Headshot rate', pct(career.headshots, career.kills)], ['Best streak', career.killStreak ? `${career.killStreak} kill${career.killStreak === 1 ? '' : 's'}` : '—']] as [label, value] (label)}
		<div class="rounded-ctl border border-black bg-ink-950 px-3.5 py-3">
			<div class="caps text-mist-400">{label}</div>
			<div class="mt-1 font-display text-xl font-semibold tabular">{value}</div>
		</div>
	{/each}
</div>
<p class="mb-3 text-[12.5px] text-mist-600">
	Rank is the place among every player seen on the servers, by all-time kills, with at least
	{career.rank.floorMinutes} minutes played; a dash means under the floor. Matches are wins-losses-draws.
	Kills, deaths and the rate per minute are the game's own counters over the matches that ended; the headshot
	rate and best streak come from the kill feed.
</p>
{#if career.seasons.length}
	<span class="field-label">Seasons</span>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Season</th><th>Kind</th><th class="num">K</th><th class="num">D</th><th class="num"
						>K/D</th
					><th class="num">Matches</th><th class="num">W-L-D</th><th>Places won</th>
				</tr>
			</thead>
			<tbody>
				{#each career.seasons as s (s.season.key)}
					<tr>
						<td class="whitespace-nowrap">
							{#if seasonHref}<a
									href={seasonHref(s.season)}
									data-sveltekit-preload-data="tap"
									class="hover:text-accent hover:underline">{s.season.name}</a
								>{:else}{s.season.name}{/if}
							{#if !isFinished(s.season, now)}<Badge tone="ok" class="ml-1.5">Live</Badge>{/if}
						</td>
						<td class="text-mist-400">{s.season.kind === 'official' ? 'Official' : orgName}</td>
						<td class="num">{fmtNum(s.kills)}</td><td class="num">{fmtNum(s.deaths)}</td>
						<td class="num">{kd(s.kills, s.deaths)}</td><td class="num">{fmtNum(s.matches)}</td>
						<td class="num whitespace-nowrap">{s.wins}-{s.losses}-{s.draws}</td>
						<td class="whitespace-nowrap">
							{#each s.places as p (p.category)}<span
									class="mr-3 inline-flex items-center gap-1.5 text-[13px]"
									><Place n={p.place} small />{CATEGORY[p.category]}</span
								>{:else}<span class="text-mist-600">—</span>{/each}
						</td>
					</tr>
				{/each}
				<tr>
					<td class="text-mist-400">All time</td><td class="text-mist-600">—</td>
					<td class="num">{fmtNum(career.kills)}</td><td class="num">{fmtNum(career.deaths)}</td>
					<td class="num">{kd(career.kills, career.deaths)}</td><td class="num"
						>{fmtNum(career.matches)}</td
					>
					<td class="num whitespace-nowrap">{career.wins}-{career.losses}-{career.draws}</td>
					<td class="text-mist-600">—</td>
				</tr>
			</tbody>
		</table>
	</div>
	<p class="note mb-4">
		A season counts the matches that ended in it, over the same servers as the rest of this page.
		Places are on this server's board when the season finished: the top three on kills, K/D (at
		least {WINNER_MIN_MATCHES} matches), playtime and wins.
	</p>
{/if}
{#if children}{@render children()}{/if}
<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
	<div>
		<span class="field-label">By map</span>
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>Map</th><th class="num">Matches</th><th class="num">W</th><th class="num">K/D</th
						></tr
					></thead
				>
				<tbody>
					{#each career.maps as m (m.key)}
						<tr>
							<td>{mapName(m.key)}</td><td class="num">{m.matches}</td><td class="num">{m.wins}</td>
							<td class="num">{kd(m.kills, m.deaths)}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="py-4 text-center text-mist-600">No matches yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
	<div>
		<span class="field-label">By faction</span>
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>Faction</th><th class="num">Matches</th><th class="num">W</th><th class="num"
							>K/D</th
						></tr
					></thead
				>
				<tbody>
					{#each career.factions as f (f.key)}
						<tr>
							<td>{f.key}</td><td class="num">{f.matches}</td><td class="num">{f.wins}</td>
							<td class="num">{kd(f.kills, f.deaths)}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="py-4 text-center text-mist-600">No matches yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
{#if career.last.length}
	<span class="mt-4 field-label"
		>Last {career.last.length === 1 ? 'match' : `${career.last.length} matches`}</span
	>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Started</th>{#if multiServer}<th>Server</th>{/if}<th>Map</th><th>Faction</th><th
						>Result</th
					>
					<th class="num">Time</th><th class="num">K</th><th class="num">D</th><th class="num"
						>Cash</th
					>
				</tr>
			</thead>
			<tbody>
				{#each career.last as m (m.matchId)}
					<tr>
						<td class="whitespace-nowrap">{fmtTime(m.startedAt)}</td>
						{#if multiServer}<td>{m.serverName}</td>{/if}
						<td>
							{#if matchHref}<a
									href={matchHref(m)}
									data-sveltekit-preload-data="tap"
									class="hover:text-accent hover:underline">{m.map ? mapName(m.map) : 'Match'}</a
								>{:else}{m.map ? mapName(m.map) : '—'}{/if}
						</td>
						<td>{m.faction || '—'}</td>
						<td class={m.result ? RESULT_TONE[m.result] : 'text-mist-600'}
							>{m.result ? RESULT_LABEL[m.result] : m.endedAt ? '—' : 'In progress'}</td
						>
						<td class="num whitespace-nowrap">{fmtLength(m.seconds)}</td>
						<td class="num">{m.kills}</td><td class="num">{m.deaths}</td>
						<td class="num {m.cashDelta > 0 ? 'text-ok' : m.cashDelta < 0 ? 'text-danger' : ''}"
							>{cash(m.cashDelta)}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="note">
		A match counts once it has ended on {serverName === orgName ? 'the server' : 'a server'}; kills
		and deaths in it are the game's own scoreboard counters.
	</p>
{/if}
