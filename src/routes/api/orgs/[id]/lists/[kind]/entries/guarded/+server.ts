import type { RequestEvent } from '@sveltejs/kit';
import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route, ApiError } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { guardedAddReservedEntry } from '$lib/server/guarded-reserve';

const context = async (event: RequestEvent) => {
	if (param(event, 'kind') !== 'reserve')
		throw new ApiError(404, 'Unknown guarded list.', 'not_found');
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return { env, org, user };
};

/** Distinct route: an older WARCON returns 404, never silently ignores guards. */
export const GET = route(async (event) => {
	await context(event);
	return apiJson({
		ok: true,
		contract: 'infh-reserve-guarded-v1',
		capabilities: [
			'exact',
			'guarded-patch',
			'guarded-delete',
			'idempotent-add',
			'expiry-cas',
			'entry-tombstone'
		]
	});
});

export const POST = route(async (event) => {
	const { env, org, user } = await context(event);
	const result = await guardedAddReservedEntry(
		env,
		event.request,
		user,
		org,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result }, result.replayed ? 200 : 201);
});
