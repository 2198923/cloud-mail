import { describe, expect, it } from 'vitest';
import oauthService from '../src/service/oauth-service';
import jwtUtils from '../src/utils/jwt-utils';

const c = { env: { jwt_secret: 'test-secret' } };

function d1(rows) {
  return {
    prepare(query) {
      return {
        bind(...params) {
          return {
            raw() {
              const externalId = String(params[0]);
              const provider = String(params[1] ?? '');
              const matching = rows.filter(row => String(row.oauth_user_id) === externalId && (
                provider === 'linuxdo'
                  ? row.platform === 'linuxdo' || row.platform === 0 || row.platform === '0' || row.platform == null
                  : row.platform === provider
              ));
              return matching.slice(0, 2).map(row => [
                row.oauth_id, row.oauth_user_id, null, null, null, null, null, null, null, row.platform, 0,
              ]);
            },
          };
        },
      };
    },
  };
}

describe('oauth identity provider isolation', () => {
  it('finds each provider when the same external id exists for all providers', async () => {
    const rows = [
      { oauth_id: 1, oauth_user_id: 'same-id', platform: 'linuxdo' },
      { oauth_id: 2, oauth_user_id: 'same-id', platform: 'github' },
      { oauth_id: 3, oauth_user_id: 'same-id', platform: 'google' },
    ];
    const context = { env: { db: d1(rows) } };
    await expect(oauthService.getById(context, 'same-id', 'linuxdo')).resolves.toMatchObject({ platform: 'linuxdo' });
    await expect(oauthService.getById(context, 'same-id', 'github')).resolves.toMatchObject({ platform: 'github' });
    await expect(oauthService.getById(context, 'same-id', 'google')).resolves.toMatchObject({ platform: 'google' });
  });

  it('treats legacy null and zero platform values as LinuxDo only', async () => {
    for (const platform of [null, 0, '0']) {
      const context = { env: { db: d1([{ oauth_id: 4, oauth_user_id: 'legacy', platform }]) } };
      await expect(oauthService.getById(context, 'legacy', 'linuxdo')).resolves.toMatchObject({ platform });
      await expect(oauthService.getById(context, 'legacy', 'github')).resolves.toBeUndefined();
    }
  });
});

describe('JWT domain isolation', () => {
  it('only accepts scoped proofs through verifyScoped and preserves normal JWTs', async () => {
    const scoped = await jwtUtils.signScoped(c, { oauthId: 1 }, 'oauth-bind');
    const normal = await jwtUtils.generateToken(c, { token: 'session' }, 300);
    await expect(jwtUtils.verifyScoped(c, scoped, 'oauth-bind')).resolves.toMatchObject({ oauthId: 1 });
    await expect(jwtUtils.verifyToken(c, scoped)).resolves.toBeNull();
    await expect(jwtUtils.verifyToken(c, normal)).resolves.toMatchObject({ token: 'session' });
  });

  it('rejects wrong purpose, tampered, and expired scoped proofs', async () => {
    const wrongPurpose = await jwtUtils.signScoped(c, { oauthId: 1 }, 'other-purpose');
    const expired = await jwtUtils.signScoped(c, { oauthId: 1 }, 'oauth-bind', -1);
    const parts = wrongPurpose.split('.');
    const tampered = `${parts[0]}.${parts[1]}.invalid`;
    await expect(jwtUtils.verifyScoped(c, wrongPurpose, 'oauth-bind')).resolves.toBeNull();
    await expect(jwtUtils.verifyScoped(c, tampered, 'other-purpose')).resolves.toBeNull();
    await expect(jwtUtils.verifyScoped(c, expired, 'oauth-bind')).resolves.toBeNull();
  });
});
