import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	settingRow: null,
}));

vi.mock('../src/entity/orm', () => ({
	default: () => ({
		select: () => ({
			from: () => ({ get: async () => mocks.settingRow }),
		}),
	}),
}));
vi.mock('../src/service/r2-service', () => ({ default: {} }));
vi.mock('../src/service/verify-record-service', () => ({ default: {} }));
vi.mock('../src/security/user-context', () => ({ default: { getToken: vi.fn() } }));
vi.mock('../src/i18n/i18n.js', () => ({ t: (key) => key }));

import settingService from '../src/service/setting-service';

function dbWithSetting(row) {
	const statements = [];
	return {
		statements,
		prepare(sql) {
			statements.push(sql.replace(/\s+/g, ' ').trim());
			return {
				bind() { return this; },
				first: vi.fn(async () => row),
				run: vi.fn(async () => ({ success: true })),
			};
		},
	};
}

describe('D1 设置真相源', () => {
	it('query 从 D1 读取设置且不访问 KV', async () => {
		mocks.settingRow = {
			register: 0, receive: 0, emailPrefixFilter: '', resendTokens: '{}',
		};
		const db = dbWithSetting(mocks.settingRow);
		const kv = { get: vi.fn(), put: vi.fn() };
		const values = new Map();
		const c = {
			env: { db, kv, domain: ['grokmail.web3wy.com'] },
			get: (key) => values.get(key),
			set: (key, value) => values.set(key, value),
		};

		const setting = await settingService.query(c);

		expect(setting.domainList).toEqual(['@grokmail.web3wy.com']);
		expect(kv.get).not.toHaveBeenCalled();
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('refresh 从 D1 读取并写入请求缓存，不写 KV', async () => {
		mocks.settingRow = { resendTokens: '{}', emailPrefixFilter: '' };
		const db = dbWithSetting(mocks.settingRow);
		const kv = { put: vi.fn() };
		const values = new Map();
		const c = {
			env: { db, kv, domain: ['grokmail.web3wy.com'] },
			set: (key, value) => values.set(key, value),
		};

		await settingService.refresh(c);

		expect(values.has('setting')).toBe(true);
		expect(kv.put).not.toHaveBeenCalled();
	});
});
