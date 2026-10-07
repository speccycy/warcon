// The public leaderboard: 404 unless leaderboards are on for the server. The org scope covers
// only the organisation's servers whose leaderboards are public too. The page leaves out the
// columns the organisation's owners chose, and a sort by one of them ranks by kills instead.
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import {
	publicHeading,
	publicLoad,
	publicOrgServers,
	requirePublicServer
} from '$lib/server/public';
import { loadBoard } from '$lib/server/leaderboards';
import { orgSeasons } from '$lib/server/seasons';
import { parseBoardQuery, publicQuery, PUBLIC_MAX_PAGE } from '$lib/leaderboard';

export const load: PageServerLoad = (event) =>
	publicLoad(event, async () => {
		const env = getEnv();
		const ps = await requirePublicServer(env, event.params.id, 'leaderboards');
		const { hidden } = await orgSeasons(env, ps.org.id);
		const q = publicQuery(parseBoardQuery(event.url.searchParams, PUBLIC_MAX_PAGE), hidden);
		const orgServers = await publicOrgServers(env, ps.org, 'leaderboards');
		const ids = q.scope === 'org' ? orgServers.map((s) => s.id) : [ps.server.id];
		return {
			board: { ...(await loadBoard(env, ids, q, ps.org.id)), maxPage: PUBLIC_MAX_PAGE },
			hidden,
			orgScope: orgServers.length > 1,
			heading: publicHeading(ps)
		};
	});
