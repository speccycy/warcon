import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { guardedPatchReservedEntryCas } from '$lib/server/guarded-reserve';

export const PATCH = route(async (event) => {
	if (param(event, 'kind') !== 'reserve')
		throw new ApiError(404, 'Unknown guarded list.', 'not_found');
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const result = await guardedPatchReservedEntryCas(
		env,
		event.request,
		user,
		org,
		param(event, 'steamId'),
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});
