import { describe, expect, it, vi } from 'vitest';
import settingService from '../src/service/setting-service';
import { migrateV31ToV33, V31_V33_COLUMNS } from '../src/init/schema-migration';
import verifyRecordService from '../src/service/verify-record-service';
import r2Service from '../src/service/r2-service';

describe('upgrade blocker regression contracts', () => {
  it('does not mutate cached settings while building a masked DTO', async () => {
    const cached = { siteKey: 'site-secret', secretKey: 'turn-secret', resendTokens: { 'a.test': 'resend-secret' }, s3AccessKey: 'access-secret', s3SecretKey: 's3-secret', tgBotToken: 'tg-secret', webhookSecret: 'hook-secret', linuxdoClientSecret: 'linux-secret', githubClientSecret: 'gh-secret', googleClientSecret: 'google-secret', emailPrefixFilter: '', regVerifyCount: 1, addVerifyCount: 1 };
    const c = { get: () => cached, set: () => {}, req: { header: () => '' }, env: { r2: null, domain: ['a.test'] } };
    vi.spyOn(verifyRecordService, 'selectListByIP').mockResolvedValue([]);
    vi.spyOn(r2Service, 'storageType').mockResolvedValue('kv');
    const dto = await settingService.get(c);
    expect(dto.secretKey).toContain('******');
    expect(cached.secretKey).toBe('turn-secret');
    expect(cached.resendTokens['a.test']).toBe('resend-secret');
  });

  it('uses safe destructive-delete default and migrates oauth platform', () => {
    expect(String(V31_V33_COLUMNS.find(([n]) => n === 'sync_delete')?.[1])).toContain('DEFAULT 1');
    expect(V31_V33_COLUMNS.find(([n]) => n === 'oauth_platform')).toBeUndefined();
  });
});
