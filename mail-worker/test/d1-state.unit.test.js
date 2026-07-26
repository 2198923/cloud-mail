import { describe, expect, it, vi } from 'vitest';
import d1StateService from '../src/service/d1-state-service';

function fakeDb(firstValue = null) {
	const calls = [];
	const db = {
		batch: vi.fn(async (statements) => statements),
		prepare(sql) {
			const call = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
			calls.push(call);
			return {
				bind(...args) { call.args = args; return this; },
				run: vi.fn(async () => ({ success: true })),
				first: vi.fn(async () => firstValue),
				all: vi.fn(async () => ({ results: [] })),
			};
		},
	};
	return { db, calls };
}

describe('D1 应用状态', () => {
	it('公共 token 写入 app_state', async () => {
		const { db, calls } = fakeDb();
		await d1StateService.setValue({ env: { db } }, 'public_token', 'abc');
		const write = calls.find(c => c.sql.includes('INSERT INTO app_state'));
		expect(write?.args).toEqual(['public_token', 'abc']);
	});

	it('每日发件计数使用原子 UPSERT', async () => {
		const { db, calls } = fakeDb();
		await d1StateService.incrementDaily({ env: { db } }, 'send', '2026-07-26', 3);
		const write = calls.find(c => c.sql.includes('INSERT INTO daily_counter'));
		expect(write?.sql).toContain('DO UPDATE SET value = value + excluded.value');
		expect(write?.args).toEqual(['send', '2026-07-26', 3]);
	});

	it('分析缓存以 JSON 写入 D1 cache', async () => {
		const { db, calls } = fakeDb();
		await d1StateService.setCache({ env: { db } }, 'analysis:UTC', { total: 2 });
		const write = calls.find(c => c.sql.includes('INSERT INTO app_cache'));
		expect(write?.args).toEqual(['analysis:UTC', '{"total":2}']);
	});

	it('D1 无公共 token 时从 KV 提升一次', async () => {
		const { db, calls } = fakeDb(null);
		const kv = { get: vi.fn(async () => 'legacy-token') };
		const value = await d1StateService.getValueCompat({ env: { db, kv } }, 'public_token', 'public_key:');
		expect(value).toBe('legacy-token');
		expect(kv.get).toHaveBeenCalledWith('public_key:');
		expect(calls.some(c => c.sql.includes('INSERT INTO app_state'))).toBe(true);
	});
});
