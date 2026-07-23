import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	routing: {
		reserveRoutes: vi.fn(),
		rollbackCreatedRoutes: vi.fn(),
	},
	user: {
		selectByEmailIncludeDel: vi.fn(),
	},
	role: {
		roleSelectUse: vi.fn(),
	},
}));

vi.mock('../src/service/email-routing-service', () => ({ default: mocks.routing }));
vi.mock('../src/service/user-service', () => ({ default: mocks.user }));
vi.mock('../src/service/role-service', () => ({ default: mocks.role }));
vi.mock('../src/utils/crypto-utils', () => ({
	default: {
		hashPassword: vi.fn(async () => ({ salt: 'salt', hash: 'hash' })),
		genRandomPwd: vi.fn(() => 'random-password'),
		verifyPassword: vi.fn(),
	},
}));
vi.mock('../src/utils/req-utils', () => ({
	default: {
		getIp: vi.fn(() => '127.0.0.1'),
		getUserAgent: vi.fn(() => ({ os: 'linux', browser: 'test', device: 'server' })),
	},
}));
vi.mock('../src/i18n/i18n', () => ({ t: (key) => key }));

import publicService from '../src/service/public-service';

function context({ batchError } = {}) {
	const prepared = [];
	const batch = vi.fn(async () => {
		if (batchError) throw batchError;
	});
	return {
		prepared,
		batch,
		c: {
			env: {
				domain: ['grokmail.web3wy.com'],
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
			},
			req: { header: vi.fn(() => '') },
		},
	};
}

describe('publicService.addUser 邮箱路由生命周期', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.user.selectByEmailIncludeDel.mockResolvedValue(undefined);
		mocks.role.roleSelectUse.mockResolvedValue([{ roleId: 1, isDefault: 1, name: '默认' }]);
		mocks.routing.reserveRoutes.mockResolvedValue([
			{ email: 'bulk@grokmail.web3wy.com', managed: true, created: true, ruleId: 'rule-1' },
		]);
	});

	it('先创建精确路由，再用参数化 D1 batch 创建批量用户', async () => {
		const { c, batch, prepared } = context();
		await publicService.addUser(c, {
			list: [{ email: ' Bulk@GrokMail.Web3wy.com ', password: 'password' }],
		});

		expect(mocks.routing.reserveRoutes).toHaveBeenCalledWith(c, ['bulk@grokmail.web3wy.com']);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(mocks.routing.reserveRoutes.mock.invocationCallOrder[0]).toBeLessThan(batch.mock.invocationCallOrder[0]);
		expect(prepared).toHaveLength(2);
		expect(prepared[0].sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
		expect(prepared[1].sql).toContain('VALUES (?, ?, (SELECT user_id');
		expect(prepared[0].sql).not.toContain('bulk@grokmail.web3wy.com');
	});

	it('D1 batch 失败时只回滚本次新建的路由', async () => {
		const dbError = new Error('D1 unavailable');
		const { c } = context({ batchError: dbError });
		await expect(publicService.addUser(c, {
			list: [{ email: 'bulk@grokmail.web3wy.com', password: 'password' }],
		})).rejects.toThrow('D1 unavailable');

		expect(mocks.routing.rollbackCreatedRoutes).toHaveBeenCalledWith(c, expect.arrayContaining([
			expect.objectContaining({ email: 'bulk@grokmail.web3wy.com', created: true }),
		]));
	});
});
