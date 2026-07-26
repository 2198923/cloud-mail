import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	user: {
		selectByEmailIncludeDel: vi.fn(),
		updateUserInfo: vi.fn(),
	},
	jwt: { generateToken: vi.fn(), verifyToken: vi.fn() },
	crypto: { verifyPassword: vi.fn() },
	context: { getToken: vi.fn() },
}));

vi.mock('../src/service/user-service', () => ({ default: mocks.user }));
vi.mock('../src/utils/jwt-utils', () => ({ default: mocks.jwt }));
vi.mock('../src/utils/crypto-utils', () => ({ default: { verifyPassword: mocks.crypto.verifyPassword } }));
vi.mock('../src/security/user-context', () => ({ default: mocks.context }));
vi.mock('../src/service/setting-service', () => ({ default: {} }));
vi.mock('../src/service/account-service', () => ({ default: {} }));
vi.mock('../src/service/role-service', () => ({ default: {} }));
vi.mock('../src/service/verify-record-service', () => ({ default: {} }));
vi.mock('../src/service/turnstile-service', () => ({ default: {} }));
vi.mock('../src/service/reg-key-service', () => ({ default: {} }));
vi.mock('../src/i18n/i18n.js', () => ({ t: (key) => key }));

import loginService from '../src/service/login-service';

function statementRecorder(results = {}) {
	const calls = [];
	const db = {
		prepare(sql) {
			const state = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
			calls.push(state);
			return {
				bind(...args) { state.args = args; return this; },
				run: vi.fn(async () => results.run || { success: true }),
				first: vi.fn(async () => results.first || null),
				all: vi.fn(async () => results.all || { results: [] }),
			};
		},
		batch: vi.fn(async () => []),
	};
	return { db, calls };
}

describe('D1 登录会话', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.user.selectByEmailIncludeDel.mockResolvedValue({
			userId: 7, email: 'admin@grokmail.web3wy.com', isDel: 0, status: 0,
			salt: 'salt', password: 'hash',
		});
		mocks.crypto.verifyPassword.mockResolvedValue(true);
		mocks.jwt.generateToken.mockResolvedValue('signed.jwt');
		mocks.context.getToken.mockResolvedValue('token-id');
	});

	it('登录只写 D1 auth_session，不访问 KV', async () => {
		const { db, calls } = statementRecorder();
		const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
		const c = { env: { db, kv }, req: { header: vi.fn(() => '') } };

		const token = await loginService.login(c, {
			email: 'admin@grokmail.web3wy.com', password: 'password',
		});

		expect(token).toBe('signed.jwt');
		expect(calls.some((call) => call.sql.includes('INSERT INTO auth_session'))).toBe(true);
		expect(calls.some((call) => call.sql.includes('DELETE FROM auth_session'))).toBe(true);
		expect(kv.get).not.toHaveBeenCalled();
		expect(kv.put).not.toHaveBeenCalled();
		expect(kv.delete).not.toHaveBeenCalled();
	});

	it('登出只删除当前 D1 token', async () => {
		const { db, calls } = statementRecorder();
		const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
		const c = { env: { db, kv } };

		await loginService.logout(c, 7);

		const deletion = calls.find((call) => call.sql.includes('DELETE FROM auth_session') && call.sql.includes('token'));
		expect(deletion?.args).toEqual([7, 'token-id']);
		expect(calls.some((call) => call.sql.includes('INSERT INTO auth_session_revocation'))).toBe(true);
		expect(kv.put).not.toHaveBeenCalled();
	});
});
