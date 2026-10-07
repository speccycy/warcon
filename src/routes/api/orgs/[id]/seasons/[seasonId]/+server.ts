import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteSeason, updateSeason } from '$lib/server/seasons';

/** {name?, startsAt?}: a new name at any time, a new start only before the season begins. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await updateSeason(
		env,
		event.request,
		user,
		org,
		param(event, 'seasonId'),
		await readJson(event.request)
	);
	return apiJson({ ok: true });
});

/** Only a season that has not begun (400 otherwise): one that has keeps its standings. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteSeason(env, event.request, user, org, param(event, 'seasonId'));
	return apiJson({ ok: true });
});
