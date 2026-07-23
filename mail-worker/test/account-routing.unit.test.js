import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	user: { selectById: vi.fn() },
	routing: { deleteRoute: vi.fn(), ensureRoute: vi.fn() },
	updateRun: vi.fn(),
}));

vi.mock('../src/service/user-service', () => ({ default: mocks.user }));
vi.mock('../src/service/email-routing-service', () => ({ default: mocks.routing }));
vi.mock('../src/entity/orm', () => ({
	default: vi.fn(() => ({
		update: vi.fn(() => ({
			set: vi.fn(() => ({
				where: vi.fn(() => ({ run: mocks.updateRun })),
			})),
		})),
	})),
}));
vi.mock('../src/i18n/i18n', () => ({ t: (key) => key }));

import accountService from '../src/service/account-service';

describe('accountService 删除保护', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.user.selectById.mockResolvedValue({ userId: 7, email: 'main@grokmail.web3wy.com' });
		mocks.routing.deleteRoute.mockResolvedValue({ managed: true, deleted: true, ruleId: 'alias-rule' });
	});

	it('邮箱不存在时返回业务错误且不调用 Cloudflare', async () => {
		vi.spyOn(accountService, 'selectById').mockResolvedValue(undefined);

		await expect(accountService.delete({ env: {} }, { accountId: 999 }, 7)).rejects.toThrow('noUserAccount');
		expect(mocks.routing.deleteRoute).not.toHaveBeenCalled();
	});

	it('D1 软删除失败且路由补偿也失败时仍保留原始 D1 错误', async () => {
		const d1Error = new Error('D1 soft delete failed');
		mocks.updateRun.mockRejectedValueOnce(d1Error);
		mocks.routing.ensureRoute.mockRejectedValueOnce(new Error('route restore failed'));
		vi.spyOn(accountService, 'selectById').mockResolvedValue({
			accountId: 10,
			userId: 7,
			email: 'alias@grokmail.web3wy.com',
		});

		await expect(accountService.delete({ env: {} }, { accountId: 10 }, 7)).rejects.toThrow('D1 soft delete failed');
		expect(mocks.routing.ensureRoute).toHaveBeenCalledWith({ env: {} }, 'alias@grokmail.web3wy.com');
	});
});
