// The organisation's seasons for its boards: the official ones and its own, and what its boards
// open on (set with PATCH /api/orgs/<id> {boardOpens}). Owners only, as the Seasons tab is.
import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createSeason, listSeasons } from '$lib/server/seasons';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, ...(await listSeasons(env, org.id)) });
});

/** {name, startsAt}: a season of the organisation's own, starting in the future. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const season = await createSeason(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, season }, 201);
});
