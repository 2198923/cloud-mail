import BizError from '../error/biz-error';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const DEFAULT_RULE_LIMIT = 200;
const GENERIC_ERROR = '邮箱路由同步失败，请稍后重试';

function routingError() {
	return new BizError(GENERIC_ERROR, 502);
}

function readConfig(c) {
	const env = c?.env || {};
	const values = {
		token: String(env.CF_EMAIL_ROUTING_TOKEN || '').trim(),
		zoneId: String(env.CF_EMAIL_ROUTING_ZONE_ID || '').trim(),
		domain: String(env.CF_EMAIL_ROUTING_DOMAIN || '').trim().toLowerCase().replace(/\.$/, ''),
		worker: String(env.CF_EMAIL_ROUTING_WORKER || '').trim(),
	};
	const configured = Object.values(values).filter(Boolean).length;

	// Keep the upstream project usable without Cloudflare rule lifecycle management.
	// Once any related value is configured, however, require the complete set and fail closed.
	if (configured === 0) return null;
	if (configured !== Object.keys(values).length) throw routingError();

	const parsedLimit = Number(env.CF_EMAIL_ROUTING_RULE_LIMIT || DEFAULT_RULE_LIMIT);
	if (!Number.isInteger(parsedLimit) || parsedLimit < 1) throw routingError();

	return { ...values, ruleLimit: parsedLimit };
}

function normalizeAddress(value) {
	const address = String(value || '').trim().toLowerCase();
	const parts = address.split('@');
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw routingError();
	return address;
}

function managedTarget(c, email) {
	const config = readConfig(c);
	if (!config) return null;
	const address = normalizeAddress(email);
	if (address.split('@')[1] !== config.domain) return null;
	return { config, address };
}

async function apiRequest(config, method, url, body, { allowConflict = false } = {}) {
	const options = {
		method,
		headers: {
			Authorization: `Bearer ${config.token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
	};
	if (body !== undefined) options.body = JSON.stringify(body);

	try {
		const response = await fetch(url, options);
		let payload;
		try {
			payload = await response.json();
		} catch {
			throw routingError();
		}
		if (allowConflict && response.status === 409) return { conflict: true };
		if (!response.ok || payload?.success !== true) throw routingError();
		return payload;
	} catch (error) {
		if (error?.name === 'BizError') throw error;
		throw routingError();
	}
}

function rulesUrl(config, page) {
	const url = new URL(`${API_BASE}/zones/${encodeURIComponent(config.zoneId)}/email/routing/rules`);
	url.searchParams.set('domain', config.domain);
	url.searchParams.set('per_page', String(PAGE_SIZE));
	url.searchParams.set('page', String(page));
	return url.toString();
}

async function listRules(config) {
	const rules = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const payload = await apiRequest(config, 'GET', rulesUrl(config, page));
		if (!Array.isArray(payload.result)) throw routingError();
		rules.push(...payload.result);

		const totalPages = Number(payload.result_info?.total_pages);
		if (Number.isInteger(totalPages) && totalPages >= 1) {
			if (totalPages > MAX_PAGES) throw routingError();
			if (page >= totalPages) return rules;
			continue;
		}

		// Cloudflare normally returns result_info. This fallback supports older/mock
		// responses without ever assuming a full page is the last page.
		if (payload.result.length < PAGE_SIZE) return rules;
	}
	throw routingError();
}

function matcherAddress(matcher) {
	if (matcher?.type !== 'literal' || matcher?.field !== 'to' || typeof matcher?.value !== 'string') return null;
	return matcher.value.trim().toLowerCase();
}

function matchesAddress(rule, address) {
	return Array.isArray(rule?.matchers) && rule.matchers.some((matcher) => matcherAddress(matcher) === address);
}

function isDesiredRule(rule, address, worker) {
	return rule?.enabled === true
		&& Array.isArray(rule.matchers)
		&& rule.matchers.length === 1
		&& matcherAddress(rule.matchers[0]) === address
		&& Array.isArray(rule.actions)
		&& rule.actions.length === 1
		&& rule.actions[0]?.type === 'worker'
		&& Array.isArray(rule.actions[0].value)
		&& rule.actions[0].value.length === 1
		&& rule.actions[0].value[0] === worker;
}

function ruleUrl(config, ruleId) {
	if (!ruleId) throw routingError();
	return `${API_BASE}/zones/${encodeURIComponent(config.zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`;
}

const emailRoutingService = {
	async reserveRoute(c, email) {
		const state = await this.ensureRoute(c, email);
		if (state.managed && !state.created) throw routingError();
		return state;
	},

	async ensureRoute(c, email) {
		const target = managedTarget(c, email);
		if (!target) return { managed: false, created: false, ruleId: null };
		const { config, address } = target;
		const rules = await listRules(config);
		const exact = rules.filter((rule) => matchesAddress(rule, address));

		if (exact.length > 0) {
			if (exact.length !== 1 || !isDesiredRule(exact[0], address, config.worker)) throw routingError();
			return { managed: true, created: false, ruleId: exact[0].id };
		}
		if (rules.length >= config.ruleLimit) throw routingError();

		const payload = {
			enabled: true,
			matchers: [{ field: 'to', type: 'literal', value: address }],
			actions: [{ type: 'worker', value: [config.worker] }],
		};
		const createResult = await apiRequest(
			config,
			'POST',
			`${API_BASE}/zones/${encodeURIComponent(config.zoneId)}/email/routing/rules`,
			payload,
			{ allowConflict: true },
		);
		if (createResult.conflict) {
			// Cloudflare enforces rule uniqueness. A concurrent creator can win after
			// our initial list; accept only the exact configured Worker rule.
			const concurrentRules = await listRules(config);
			const concurrentExact = concurrentRules.filter((rule) => matchesAddress(rule, address));
			if (concurrentExact.length === 1 && isDesiredRule(concurrentExact[0], address, config.worker)) {
				return { managed: true, created: false, ruleId: concurrentExact[0].id };
			}
			throw routingError();
		}
		const created = createResult.result;
		if (!created?.id || !isDesiredRule(created, address, config.worker)) {
			if (created?.id) {
				try {
					await apiRequest(config, 'DELETE', ruleUrl(config, created.id));
				} catch {
					// Preserve a generic public error; reconciliation can find this exact ID.
				}
			}
			throw routingError();
		}
		return { managed: true, created: true, ruleId: created.id };
	},

	async deleteRoute(c, email) {
		const target = managedTarget(c, email);
		if (!target) return { managed: false, deleted: false, ruleId: null };
		const { config, address } = target;
		const rules = await listRules(config);
		const exact = rules.filter((rule) => matchesAddress(rule, address));
		if (exact.length === 0) return { managed: true, deleted: false, ruleId: null };
		if (exact.length !== 1 || !isDesiredRule(exact[0], address, config.worker)) throw routingError();

		await apiRequest(config, 'DELETE', ruleUrl(config, exact[0].id));
		return { managed: true, deleted: true, ruleId: exact[0].id };
	},

	async rollbackCreatedRoute(c, email, routeState) {
		if (!routeState?.created || !routeState.ruleId) return;
		const target = managedTarget(c, email);
		if (!target) return;
		const { config, address } = target;
		const rules = await listRules(config);
		const createdRule = rules.find((rule) => rule?.id === routeState.ruleId);
		if (!createdRule) return;
		if (!isDesiredRule(createdRule, address, config.worker)) throw routingError();
		await apiRequest(config, 'DELETE', ruleUrl(config, routeState.ruleId));
	},

	async ensureRoutes(c, emails) {
		const states = [];
		try {
			for (const email of [...new Set((emails || []).map((value) => normalizeAddress(value)))]) {
				states.push({ email, ...(await this.ensureRoute(c, email)) });
			}
			return states;
		} catch (error) {
			for (const state of states.slice().reverse()) {
				try {
					await this.rollbackCreatedRoute(c, state.email, state);
				} catch {
					// Do not expose Cloudflare details or credentials while preserving the original failure.
				}
			}
			throw error;
		}
	},

	async reserveRoutes(c, emails) {
		const states = [];
		try {
			for (const email of [...new Set((emails || []).map((value) => normalizeAddress(value)))]) {
				states.push({ email, ...(await this.reserveRoute(c, email)) });
			}
			return states;
		} catch (error) {
			await this.rollbackCreatedRoutes(c, states);
			throw error;
		}
	},

	async rollbackCreatedRoutes(c, states) {
		let failed = 0;
		for (const state of (states || []).slice().reverse()) {
			try {
				await this.rollbackCreatedRoute(c, state.email, state);
			} catch {
				failed += 1;
			}
		}
		return { failed };
	},

	async deleteRoutes(c, emails) {
		const states = [];
		try {
			for (const email of [...new Set((emails || []).map((value) => normalizeAddress(value)))]) {
				states.push({ email, ...(await this.deleteRoute(c, email)) });
			}
			return states;
		} catch (error) {
			for (const state of states.filter((item) => item.deleted)) {
				try {
					await this.ensureRoute(c, state.email);
				} catch {
					// Keep the public error generic; reconciliation can repair a rare failed compensation.
				}
			}
			throw error;
		}
	},

	async restoreDeletedRoutes(c, states) {
		let failed = 0;
		for (const state of (states || []).filter((item) => item.deleted)) {
			try {
				await this.ensureRoute(c, state.email);
			} catch {
				failed += 1;
			}
		}
		return { failed };
	},
};

export default emailRoutingService;
