import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	crypto: { hashPassword: vi.fn(async () => ({ salt: 'new-salt', hash: 'new-hash' })) },
	account: { physicsDeleteByUserIds: vi.fn(async () => undefined) },
	oauth: { deleteByUserIds: vi.fn(async () => undefined) },
}));

vi.mock('../src/utils/crypto-utils', () => ({ default: mocks.crypto }));
vi.mock('../src/service/account-service', () => ({ default: mocks.account }));
vi.mock('../src/service/oauth-service', () => ({ default: mocks.oauth }));
vi.mock('../src/entity/orm', () => ({
	default: () => ({ delete: () => ({ where: () => ({ run: vi.fn(async () => undefined) }) }) }),
}));
vi.mock('../src/i18n/i18n', () => ({ t: (key) => key }));

import userService from '../src/service/user-service';

function context() {
	const calls = [];
	const db = {
		prepare(sql) {
			const call = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
			calls.push(call);
			return { bind(...args) { call.args = args; return this; } };
		},
		batch: vi.fn(async () => undefined),
	};
	return { c: { env: { db } }, db, calls };
}

describe('密码和物理删除撤销会话', () => {
	it('用户自行改密在同一 D1 batch 更新密码并撤销全部会话', async () => {
		const { c, db, calls } = context();
		await userService.resetPassword(c, { password: 'new-password' }, 7);
		expect(db.batch).toHaveBeenCalledTimes(1);
		expect(calls.find(x => x.sql.includes('UPDATE user SET password'))?.args).toEqual(['new-hash', 'new-salt', 7]);
		expect(calls.some(x => x.sql.includes('INSERT INTO auth_session_legacy_block'))).toBe(true);
		expect(calls.some(x => x.sql.includes('DELETE FROM auth_session'))).toBe(true);
	});

	it('物理删除用户前先写 legacy block 并清理 D1 session', async () => {
		const { c, db, calls } = context();
		await userService.physicsDelete(c, { userIds: '7,8' });
		expect(db.batch).toHaveBeenCalledTimes(1);
		const block = calls.find(x => x.sql.includes('INSERT INTO auth_session_legacy_block'));
		expect(block?.args).toEqual([7, 8]);
		expect(calls.find(x => x.sql.includes('DELETE FROM auth_session'))?.args).toEqual([7, 8]);
		expect(mocks.account.physicsDeleteByUserIds).toHaveBeenCalledWith(c, [7, 8]);
	});
});
