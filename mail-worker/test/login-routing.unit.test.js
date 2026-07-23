import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingConst } from '../src/const/entity-const';

const mocks = vi.hoisted(() => ({
	user: {
		createWithAccount: vi.fn(),
	},
	account: {
		selectByEmailIncludeDel: vi.fn(),
	},
	setting: { query: vi.fn() },
	role: {
		selectDefaultRole: vi.fn(),
		selectById: vi.fn(),
		hasAvailDomainPerm: vi.fn(),
	},
	crypto: { hashPassword: vi.fn() },
}));

vi.mock('../src/service/user-service', () => ({ default: mocks.user }));
vi.mock('../src/service/account-service', () => ({ default: mocks.account }));
vi.mock('../src/service/setting-service', () => ({ default: mocks.setting }));
vi.mock('../src/service/role-service', () => ({ default: mocks.role }));
vi.mock('../src/utils/crypto-utils', () => ({
	default: {
		hashPassword: mocks.crypto.hashPassword,
		verifyPassword: vi.fn(),
	},
}));
vi.mock('../src/service/verify-record-service', () => ({ default: {} }));
vi.mock('../src/service/turnstile-service', () => ({ default: {} }));
vi.mock('../src/service/reg-key-service', () => ({ default: {} }));
vi.mock('../src/i18n/i18n.js', () => ({ t: (key) => key }));

import loginService from '../src/service/login-service';

describe('loginService 注册路由顺序', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.setting.query.mockResolvedValue({
			regKey: settingConst.regKey.CLOSE,
			register: settingConst.register.OPEN,
			registerVerify: settingConst.registerVerify.CLOSE,
			regVerifyCount: 0,
			minEmailPrefix: 1,
			emailPrefixFilter: [],
		});
		mocks.account.selectByEmailIncludeDel.mockResolvedValue(undefined);
		mocks.role.selectDefaultRole.mockResolvedValue({ roleId: 1 });
		mocks.role.selectById.mockResolvedValue({ roleId: 1, availDomain: '*' });
		mocks.role.hasAvailDomainPerm.mockReturnValue(true);
		mocks.crypto.hashPassword.mockResolvedValue({ salt: 'salt', hash: 'hash' });
		mocks.user.createWithAccount.mockResolvedValue({ routeState: { created: true, ruleId: 'route' } });
	});

	it('注册委托给先路由后原子 D1 的 createWithAccount', async () => {
		const c = {
			env: { domain: ['grokmail.web3wy.com'] },
			req: { header: vi.fn(() => '') },
		};

		await loginService.register(c, {
			email: ' Register@GrokMail.Web3wy.com ',
			password: 'password',
		});

		expect(mocks.user.createWithAccount).toHaveBeenCalledWith(c, {
			email: 'register@grokmail.web3wy.com',
			regKeyId: 0,
			password: 'hash',
			salt: 'salt',
			type: 1,
		});
	});
});
