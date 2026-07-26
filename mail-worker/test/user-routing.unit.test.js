import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	account: {
		selectByUserId: vi.fn(),
		selectByEmailIncludeDel: vi.fn(),
	},
	role: { selectById: vi.fn() },

	routing: {
		reserveRoute: vi.fn(),
		rollbackCreatedRoute: vi.fn(),
		deleteRoutes: vi.fn(),
		restoreDeletedRoutes: vi.fn(),
		ensureRoutes: vi.fn(),
		rollbackCreatedRoutes: vi.fn(),
	},
}));

vi.mock('../src/service/account-service', () => ({ default: mocks.account }));
vi.mock('../src/service/email-routing-service', () => ({ default: mocks.routing }));
vi.mock('../src/service/role-service', () => ({ default: mocks.role }));
vi.mock('../src/utils/crypto-utils', () => ({
	default: { hashPassword: vi.fn(async () => ({ salt: 'salt', hash: 'hash' })) },
}));
vi.mock('../src/entity/orm', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../src/i18n/i18n', () => ({ t: (key) => key }));

import userService from '../src/service/user-service';

function context() {
	const prepared = [];
	const batch = vi.fn(async () => undefined);
	return {
		prepared,
		batch,
		c: {
			env: {
				db: {
					prepare(sql) {
						const statement = {
							sql,
							args: [],
							bind(...args) {
								this.args = args;
								return this;
							},
						};
						prepared.push(statement);
						return statement;
					},
					batch,
				},
				kv: { delete: vi.fn(async () => undefined) },
			},
		},
	};
}

const accounts = [
	{ email: 'main@grokmail.web3wy.com', isDel: 0 },
	{ email: 'alias@grokmail.web3wy.com', isDel: 0 },
	{ email: 'old-deleted@grokmail.web3wy.com', isDel: 1 },
];

describe('userService 邮箱路由生命周期', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.account.selectByUserId.mockResolvedValue(accounts);
		mocks.account.selectByEmailIncludeDel.mockResolvedValue(undefined);
		mocks.routing.deleteRoutes.mockResolvedValue([]);
		mocks.routing.ensureRoutes.mockResolvedValue([]);
		mocks.routing.reserveRoute.mockResolvedValue({ managed: true, created: true, ruleId: 'reserved' });
		mocks.routing.rollbackCreatedRoute.mockResolvedValue();
	});

	it('用户软删除保持原有 account 状态，只删除路由并标记 user', async () => {
		const { c, prepared, batch } = context();
		vi.spyOn(userService, 'selectById').mockResolvedValue({ userId: 7, email: accounts[0].email });

		await userService.delete(c, 7);

		expect(mocks.routing.deleteRoutes).toHaveBeenCalledWith(c, [
			'main@grokmail.web3wy.com',
			'alias@grokmail.web3wy.com',
		]);
		expect(batch).toHaveBeenCalledTimes(1);
		const userUpdates = prepared.filter((statement) => statement.sql.includes('UPDATE user SET is_del'));
		const sessionDeletes = prepared.filter((statement) => statement.sql.includes('DELETE FROM auth_session'));
		const legacyBlocks = prepared.filter((statement) => statement.sql.includes('INSERT INTO auth_session_legacy_block'));
		expect(userUpdates).toHaveLength(1);
		expect(userUpdates[0].sql).not.toContain('UPDATE account');
		expect(sessionDeletes).toHaveLength(1);
		expect(legacyBlocks).toHaveLength(1);
	});

	it('软删除的用户状态与会话撤销原子失败时恢复邮箱路由', async () => {
		const { c, batch } = context();
		vi.spyOn(userService, 'selectById').mockResolvedValue({ userId: 7, email: accounts[0].email });
		const routeStates = [{ email: accounts[0].email, managed: true }];
		mocks.routing.deleteRoutes.mockResolvedValue(routeStates);
		batch.mockRejectedValueOnce(new Error('D1 revoke failed'));

		await expect(userService.delete(c, 7)).rejects.toThrow('D1 revoke failed');
		expect(mocks.routing.restoreDeletedRoutes).toHaveBeenCalledWith(c, routeStates);
	});

	it('普通恢复重建主邮箱和所有仍活跃别名，不恢复已删除别名', async () => {
		const { c } = context();
		vi.spyOn(userService, 'selectByIdIncludeDel').mockResolvedValue({ userId: 7, email: accounts[0].email });

		await userService.restore(c, { userId: 7, type: false });

		expect(mocks.routing.ensureRoutes).toHaveBeenCalledWith(c, [
			'main@grokmail.web3wy.com',
			'alias@grokmail.web3wy.com',
		]);
	});

	it('完整恢复会重建该用户全部邮箱路由', async () => {
		const { c } = context();
		vi.spyOn(userService, 'selectByIdIncludeDel').mockResolvedValue({ userId: 7, email: accounts[0].email });

		await userService.restore(c, { userId: 7, type: true });

		expect(mocks.routing.ensureRoutes).toHaveBeenCalledWith(c, accounts.map((row) => row.email));
	});

	it('管理员新增用户必须等待角色查询并拒绝不存在的角色', async () => {
		const { c } = context();
		c.env.domain = ['grokmail.web3wy.com'];
		mocks.role.selectById.mockResolvedValue(undefined);
		const createSpy = vi.spyOn(userService, 'createWithAccount').mockResolvedValue({});

		await expect(userService.add(c, {
			email: 'invalid-role@grokmail.web3wy.com',
			password: 'password',
			type: 999,
		})).rejects.toThrow('roleNotExist');
		expect(createSpy).not.toHaveBeenCalled();
	});

	it('新建主账号必须先保留路由，再原子写入 user 和 account', async () => {
		const { c, batch, prepared } = context();
		c.req = { header: vi.fn(() => '') };

		await userService.createWithAccount(c, {
			email: 'ordered@grokmail.web3wy.com',
			password: 'hash',
			salt: 'salt',
			type: 1,
			regKeyId: 0,
		});

		expect(mocks.routing.reserveRoute).toHaveBeenCalledWith(c, 'ordered@grokmail.web3wy.com');
		expect(mocks.routing.reserveRoute.mock.invocationCallOrder[0]).toBeLessThan(batch.mock.invocationCallOrder[0]);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(prepared).toHaveLength(2);
		expect(prepared[0].sql).toContain('INSERT INTO user');
		expect(prepared[1].sql).toContain('INSERT INTO account');
	});

	it('主账号 D1 原子写入失败时回滚本次保留的路由', async () => {
		const { c, batch } = context();
		c.req = { header: vi.fn(() => '') };
		batch.mockRejectedValueOnce(new Error('D1 create failed'));

		await expect(userService.createWithAccount(c, {
			email: 'rollback-main@grokmail.web3wy.com',
			password: 'hash',
			salt: 'salt',
			type: 1,
			regKeyId: 0,
		})).rejects.toThrow('D1 create failed');

		expect(mocks.routing.rollbackCreatedRoute).toHaveBeenCalledWith(
			c,
			'rollback-main@grokmail.web3wy.com',
			{ managed: true, created: true, ruleId: 'reserved' },
		);
	});

	it('管理员新增委托给先路由后原子 D1 的 createWithAccount', async () => {
		const { c } = context();
		c.env.domain = ['grokmail.web3wy.com'];
		mocks.role.selectById.mockResolvedValue({ roleId: 1 });
		const createSpy = vi.spyOn(userService, 'createWithAccount').mockResolvedValue({
			routeState: { created: true, ruleId: 'rule-9' },
		});

		await userService.add(c, {
			email: ' AdminCreate@GrokMail.Web3wy.com ',
			password: 'password',
			type: 1,
		});

		expect(createSpy).toHaveBeenCalledWith(c, {
			email: 'admincreate@grokmail.web3wy.com',
			password: 'hash',
			salt: 'salt',
			type: 1,
			regKeyId: 0,
		});
	});
});
