import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import { and, eq, inArray } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import settingService from "./setting-service";
import {t} from '../i18n/i18n';
import jwtUtils from '../utils/jwt-utils';

const oauthService = {

	async bindUser(c, params) {

		const { email, code, bindToken } = params;
		const ticket = await jwtUtils.verifyScoped(c, bindToken, 'oauth-bind');
		if (!ticket || !ticket.oauthId || !ticket.provider || !ticket.externalId) throw new BizError('invalid oauth bind proof');
		const rows = await orm(c).select().from(oauth).where(eq(oauth.oauthId, ticket.oauthId)).limit(2).all();
		if (rows.length !== 1 || String(rows[0].oauthUserId) !== String(ticket.externalId) || this.normalizePlatform(rows[0].platform) !== ticket.provider) throw new BizError('invalid oauth bind proof');
		const oauthRow = rows[0];

		let userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (userRow) {
			throw new BizError('用户已绑定有邮箱')
		}

		await loginService.register(c, { email, password: cryptoUtils.genRandomPwd(), code }, true);

		userRow = await userService.selectByEmail(c, email);

		const updated = await orm(c).update(oauth).set({ userId: userRow.userId }).where(and(eq(oauth.oauthId, ticket.oauthId), eq(oauth.userId, 0))).returning().get();
		if (!updated) throw new BizError('oauth bind already used');
		const jwtToken = await loginService.login(c, { email, password: null }, true);

		return { userInfo: updated, token: jwtToken}
	},

	async linuxDoLogin(c, params) {

		const { code, redirectUri } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'linuxdoSwitch');
		const clientId = setting.linuxdoClientId || c.env.linuxdo_client_id;
		const clientSecret = setting.linuxdoClientSecret || c.env.linuxdo_client_secret;
		const callbackUrl = redirectUri || c.env.linuxdo_callback_url;
		if (!clientId || !clientSecret || !callbackUrl) throw new BizError('LinuxDo OAuth credentials are not configured');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', clientId)
		reqParams.append('client_secret', clientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', callbackUrl)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const token = await tokenRes.json()

		const userRes = await fetch('https://connect.linux.do/api/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.active = userInfo.active ? 0 : 1;
		userInfo.silenced = userInfo.silenced ? 0 : 1;
		userInfo.trustLevel = userInfo.trust_level;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'linuxdo';

		return await this.saveAndLogin(c, userInfo)
	},

	async githubLogin(c, params) {

		const { code, redirectUri } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'githubSwitch');

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			body: JSON.stringify({
				client_id: setting.githubClientId,
				client_secret: setting.githubClientSecret,
				code: code,
				redirect_uri: redirectUri
			})
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		if (token.error) {
			throw new BizError(token.error_description || token.error);
		}

		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token,
				'User-Agent': 'cloud-mail'
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.username = userInfo.login;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'github';

		return await this.saveAndLogin(c, userInfo);
	},

	async googleLogin(c, params) {

		const { code, redirectUri } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'googleSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.googleClientId)
		reqParams.append('client_secret', setting.googleClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.sub);
		userInfo.username = userInfo.email;
		userInfo.name = userInfo.name;
		userInfo.avatar = userInfo.picture;
		userInfo.platform = 'google';

		return await this.saveAndLogin(c, userInfo);
	},

	async saveAndLogin(c, userInfo) {

		const oauthRow = await this.saveUser(c, userInfo);
		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			return { userInfo: oauthRow, bindToken: await jwtUtils.signScoped(c, { oauthId: oauthRow.oauthId, provider: this.normalizePlatform(oauthRow.platform), externalId: String(oauthRow.oauthUserId) }, 'oauth-bind'), token: null };
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken };
	},

	async saveUser(c, userInfo) {

		const provider = this.normalizePlatform(userInfo.platform);
		const userInfoRow = await this.getById(c, userInfo.oauthUserId, provider);

		if (!userInfoRow) {
			return await orm(c).insert(oauth).values(userInfo).returning().get();
		} else {
			return await orm(c).update(oauth).set(userInfo).where(eq(oauth.oauthId, userInfoRow.oauthId)).returning().get();
		}

	},

	assertEnabled(setting, switchKey) {
		if (setting[switchKey] !== 0) {
			throw new BizError(t('oauthDisabled'));
		}
	},

	assertPlatform(platform) {
		if (!['linuxdo', 'github', 'google'].includes(platform)) throw new BizError('invalid oauth platform');
	},

	normalizePlatform(platform) {
		if (platform === null || platform === undefined || platform === 0 || platform === '0') return 'linuxdo';
		this.assertPlatform(platform);
		return platform;
	},

	async getById(c, oauthUserId, platform = 'linuxdo') {
		const provider = this.normalizePlatform(platform);
		const rows = await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, oauthUserId)).limit(2).all();
		const matches = rows.filter(row => this.normalizePlatform(row.platform) === provider);
		if (matches.length > 1) throw new BizError('ambiguous oauth identity');
		return matches[0];
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户
	async clearNoBindOathUser(c) {
		await orm(c).delete(oauth).where(eq(oauth.userId, 0)).run();
	},

}

export default  oauthService
