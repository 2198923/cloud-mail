import { afterEach, describe, expect, it, vi } from 'vitest';
import emailRoutingService from '../src/service/email-routing-service';

const zoneId = 'zone-test';
const domain = 'grokmail.web3wy.com';
const worker = 'cloud-mail-grok';
const token = 'unit-test-token';

function context(extra = {}) {
	return {
		env: {
			CF_EMAIL_ROUTING_TOKEN: token,
			CF_EMAIL_ROUTING_ZONE_ID: zoneId,
			CF_EMAIL_ROUTING_DOMAIN: domain,
			CF_EMAIL_ROUTING_WORKER: worker,
			...extra,
		},
	};
}

function apiResponse(result, ok = true, status = 200, resultInfo) {
	return {
		ok,
		status,
		async json() {
			return { success: ok, result, ...(resultInfo ? { result_info: resultInfo } : {}) };
		},
	};
}

function rule(id, email, actions = [{ type: 'worker', value: [worker] }]) {
	return {
		id,
		enabled: true,
		matchers: [{ field: 'to', type: 'literal', value: email }],
		actions,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('email routing exact rules', () => {
	it('is idempotent when the exact address already routes to the configured Worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiResponse([
			rule('same-worker', 'Alice@' + domain),
			rule('unrelated', 'other@' + domain),
		]));
		vi.stubGlobal('fetch', fetchMock);

		const state = await emailRoutingService.ensureRoute(context(), `alice@${domain}`);

		expect(state).toEqual({ managed: true, created: false, ruleId: 'same-worker' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		const parsed = new URL(url);
		expect(parsed.pathname).toBe(`/client/v4/zones/${zoneId}/email/routing/rules`);
		expect(parsed.searchParams.get('domain')).toBe(domain);
		expect(parsed.searchParams.get('per_page')).toBe('50');
		expect(url).not.toContain('catch_all');
		expect(options.headers.Authorization).toBe(`Bearer ${token}`);
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
	});

	it('reserving a new mailbox fails closed when an exact route already exists', async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiResponse([
			rule('already-owned', `reserved@${domain}`),
		]));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailRoutingService.reserveRoute(context(), `reserved@${domain}`)).rejects.toThrow(/邮箱路由同步失败/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
	});

	it('walks every Cloudflare result page before deciding an address is absent', async () => {
		const firstPage = Array.from({ length: 50 }, (_, index) => rule(`other-${index}`, `other-${index}@${domain}`));
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse(firstPage, true, 200, { page: 1, total_pages: 2 }))
			.mockResolvedValueOnce(apiResponse([rule('page-two', `paged@${domain}`)], true, 200, { page: 2, total_pages: 2 }));
		vi.stubGlobal('fetch', fetchMock);

		const state = await emailRoutingService.ensureRoute(context(), `paged@${domain}`);

		expect(state).toEqual({ managed: true, created: false, ruleId: 'page-two' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('page')).toBe('1');
		expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('page')).toBe('2');
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
	});

	it('creates an exact literal Worker rule only after the list confirms no conflict', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse([]))
			.mockResolvedValueOnce(apiResponse(rule('created', `new@${domain}`)));
		vi.stubGlobal('fetch', fetchMock);

		const state = await emailRoutingService.ensureRoute(context(), `NEW@${domain}`);

		expect(state).toEqual({ managed: true, created: true, ruleId: 'created' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [url, options] = fetchMock.mock.calls[1];
		expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`);
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({
			enabled: true,
			matchers: [{ field: 'to', type: 'literal', value: `new@${domain}` }],
			actions: [{ type: 'worker', value: [worker] }],
		});
	});

	it('treats a concurrent duplicate-rule 409 as idempotent after a safe re-read', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse([]))
			.mockResolvedValueOnce(apiResponse(null, false, 409))
			.mockResolvedValueOnce(apiResponse([rule('concurrent-winner', `race@${domain}`)]));
		vi.stubGlobal('fetch', fetchMock);

		const state = await emailRoutingService.ensureRoute(context(), `race@${domain}`);

		expect(state).toEqual({ managed: true, created: false, ruleId: 'concurrent-winner' });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[1][1].method).toBe('POST');
		expect(fetchMock.mock.calls[2][1].method).toBe('GET');
	});

	it('rejects an exact-address rule owned by another action without attempting creation', async () => {
		const secret = 'do-not-leak-this-token';
		const fetchMock = vi.fn().mockResolvedValue(apiResponse([
			rule('conflict', `taken@${domain}`, [{ type: 'forward', value: ['destination@example.net'] }]),
		]));
		vi.stubGlobal('fetch', fetchMock);

		let message = '';
		try {
			await emailRoutingService.ensureRoute(context({ CF_EMAIL_ROUTING_TOKEN: secret }), `taken@${domain}`);
		} catch (error) {
			message = error.message;
		}
		expect(message).toMatch(/邮箱路由同步失败/);
		expect(message).not.toContain(secret);
		expect(message).not.toContain('destination@example.net');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
	});

	it('deletes the unique exact-address rule for the configured Worker', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse([
				rule('target', `delete@${domain}`),
				rule('other-address', `keep@${domain}`),
			]))
			.mockResolvedValueOnce(apiResponse(null));
		vi.stubGlobal('fetch', fetchMock);

		const state = await emailRoutingService.deleteRoute(context(), `delete@${domain}`);

		expect(state).toEqual({ managed: true, deleted: true, ruleId: 'target' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [url, options] = fetchMock.mock.calls[1];
		expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/target`);
		expect(options.method).toBe('DELETE');
		expect(url).not.toContain('catch_all');
	});

	it('fails closed and deletes nothing when multiple rules match the same address', async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiResponse([
			rule('target', `conflicted@${domain}`),
			rule('forward', `conflicted@${domain}`, [{ type: 'forward', value: ['else@example.net'] }]),
		]));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailRoutingService.deleteRoute(context(), `conflicted@${domain}`)).rejects.toThrow(/邮箱路由同步失败/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'DELETE')).toBe(false);
	});

	it('fails closed at the configured exact-rule capacity', async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiResponse([rule('occupied', `occupied@${domain}`)]));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailRoutingService.ensureRoute(context({ CF_EMAIL_ROUTING_RULE_LIMIT: '1' }), `full@${domain}`)).rejects.toThrow(/邮箱路由同步失败/);
		expect(fetchMock.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
	});

	it('rolls back only the exact rule created by the current operation', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse([rule('created-here', `rollback@${domain}`)]))
			.mockResolvedValueOnce(apiResponse(null));
		vi.stubGlobal('fetch', fetchMock);

		await emailRoutingService.rollbackCreatedRoute(context(), `rollback@${domain}`, {
			created: true,
			ruleId: 'created-here',
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
		expect(fetchMock.mock.calls[1][0]).toMatch(/\/rules\/created-here$/);
	});

	it('does not call Cloudflare when routing integration is entirely unconfigured', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(await emailRoutingService.ensureRoute({ env: {} }, 'upstream@example.com')).toEqual({ managed: false, created: false, ruleId: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails closed with a generic error when Cloudflare rejects a request', async () => {
		const secret = 'another-secret-that-must-not-appear';
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			async json() {
				return { success: false, errors: [{ message: `token=${secret}` }] };
			},
		}));

		let message = '';
		try {
			await emailRoutingService.ensureRoute(context({ CF_EMAIL_ROUTING_TOKEN: secret }), `api-error@${domain}`);
		} catch (error) {
			message = error.message;
		}
		expect(message).toMatch(/邮箱路由同步失败/);
		expect(message).not.toContain(secret);
	});

	it('deletes a just-created rule when Cloudflare returns an unexpected representation', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(apiResponse([]))
			.mockResolvedValueOnce(apiResponse({
				id: 'unexpected-created',
				enabled: false,
				matchers: [{ field: 'to', type: 'literal', value: `unexpected@${domain}` }],
				actions: [{ type: 'worker', value: [worker] }],
			}))
			.mockResolvedValueOnce(apiResponse(null));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailRoutingService.ensureRoute(context(), `unexpected@${domain}`)).rejects.toThrow(/邮箱路由同步失败/);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2][0]).toMatch(/\/rules\/unexpected-created$/);
		expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
	});

	it('batch route rollback is best-effort and never skips later items', async () => {
		const spy = vi.spyOn(emailRoutingService, 'rollbackCreatedRoute')
			.mockRejectedValueOnce(new Error('first rollback failed'))
			.mockResolvedValueOnce();

		const result = await emailRoutingService.rollbackCreatedRoutes(context(), [
			{ email: `one@${domain}`, created: true, ruleId: 'one' },
			{ email: `two@${domain}`, created: true, ruleId: 'two' },
		]);

		expect(spy).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ failed: 1 });
		spy.mockRestore();
	});

	it('deleted-route compensation restores every item independently', async () => {
		const spy = vi.spyOn(emailRoutingService, 'ensureRoute')
			.mockRejectedValueOnce(new Error('first restore failed'))
			.mockResolvedValueOnce({ managed: true, created: true, ruleId: 'two' });

		const result = await emailRoutingService.restoreDeletedRoutes(context(), [
			{ email: `one@${domain}`, deleted: true, ruleId: 'one' },
			{ email: `two@${domain}`, deleted: true, ruleId: 'two' },
		]);

		expect(spy).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ failed: 1 });
		spy.mockRestore();
	});
});
