import type { RequestEvent } from '@sveltejs/kit';
import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route, ApiError } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import {
	exactReservedEntry,
	exactReservedEvidence,
	guardedPatchReservedEntry,
	guardedRemoveReservedEntry
} from '$lib/server/guarded-reserve';

const context = async (event: RequestEvent) => {
	if (param(event, 'kind') !== 'reserve')
		throw new ApiError(404, 'Unknown guarded list.', 'not_found');
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return { env, org, user, steamId: param(event, 'steamId') };
};

export const GET = route(async (event) => {
	const { env, org, steamId } = await context(event);
	const oldId = event.url.searchParams.get('expectedEntryId');
	if (oldId !== null)
		return apiJson({ ok: true, evidence: await exactReservedEvidence(env, org, steamId, oldId) });
	return apiJson({ ok: true, entry: await exactReservedEntry(env, org, steamId) });
});

export const PATCH = route(async (event) => {
	const { env, org, user, steamId } = await context(event);
	const result = await guardedPatchReservedEntry(
		env,
		event.request,
		user,
		org,
		steamId,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});

export const DELETE = route(async (event) => {
	const { env, org, user, steamId } = await context(event);
	const result = await guardedRemoveReservedEntry(
		env,
		event.request,
		user,
		org,
		steamId,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});
