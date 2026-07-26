import { describe, expect, it, vi } from 'vitest';
import authSessionService from '../src/service/auth-session-service';

function context({ d1Session = null, revoked = null, legacy = null } = {}) {
	const calls = [];
	const db = {
		prepare(sql) {
			const call = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
			calls.push(call);
			return {
				bind(...args) { call.args = args; return this; },
				async first() {
					if (call.sql.includes('FROM auth_session_revocation')) return revoked;
					if (call.sql.includes('FROM auth_session')) return d1Session;
					return null;
				},
				async run() { return { success: true }; },
			};
		},
		batch: vi.fn(async () => []),
	};
	const kv = { get: vi.fn(async () => legacy) };
	return { c: { env: { db, kv } }, calls, kv };
}

describe('旧 KV 会话兼容', () => {
	it('D1 miss 时接受未撤销的旧 KV token 并提升到 D1', async () => {
		const { c, calls } = context({ legacy: { tokens: ['legacy-token'] } });
		expect(await authSessionService.valid(c, 7, 'legacy-token')).toBe(true);
		expect(calls.some(call => call.sql.includes('INSERT INTO auth_session'))).toBe(true);
	});

	it('已撤销旧 token 不会被 KV fallback 复活', async () => {
		const { c, kv } = context({ revoked: { revoked: 1 }, legacy: { tokens: ['legacy-token'] } });
		expect(await authSessionService.valid(c, 7, 'legacy-token')).toBe(false);
		expect(kv.get).not.toHaveBeenCalled();
	});
});
