import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import {verifyRecordType} from '../const/entity-const';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import {t} from '../i18n/i18n'
import verifyRecordService from './verify-record-service';
import userContext from '../security/user-context';
import domainUtils from '../utils/domain-uitls';

const settingService = {

	async refresh(c) {
		const settingRow = await orm(c).select().from(setting).get();
		settingRow.resendTokens = JSON.parse(settingRow.resendTokens);
		c.set('setting', settingRow);
		await c.env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	},

	async query(c) {

		if (c.get?.('setting')) {
			return structuredClone(c.get('setting'))
		}

		const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });

		if (!setting) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}

		const settingData = structuredClone(setting);
		let domainList = c.env.domain;

		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList)
			} catch (error) {
				throw new BizError(t('notJsonDomain'));
			}
		}

		if (!c.env.domain) {
			throw new BizError(t('noDomainVariable'));
		}

		domainList = domainList.map(item => '@' + item);
		settingData.domainList = domainList;

		let projectLink = c.env.project_link;
		if (typeof projectLink === 'string' && projectLink === 'false') {
			projectLink = false
		} else if (projectLink === false) {
			projectLink = false
		} else {
			projectLink = true
		}

		settingData.projectLink = projectLink;

		settingData.emailPrefixFilter = settingData.emailPrefixFilter.split(",").filter(Boolean);

		c.set?.('setting', structuredClone(settingData));
		return settingData;
	},

	async get(c, showSiteKey = false) {

		const [settingRow, recordList] = await Promise.all([
			await this.query(c),
			verifyRecordService.selectListByIP(c)
		]);


		const response = structuredClone(settingRow);
		if (!showSiteKey) {
			response.siteKey = response.siteKey ? `${response.siteKey.slice(0, 6)}******` : null;
		}

		response.secretKey = response.secretKey ? `${response.secretKey.slice(0, 6)}******` : null;

		Object.keys(response.resendTokens).forEach(key => {
			response.resendTokens[key] = `${response.resendTokens[key].slice(0, 12)}******`;
		});

		response.s3SecretKey = response.s3SecretKey ? `${response.s3SecretKey.slice(0, 12)}******` : null;
		response.tgBotToken = response.tgBotToken ? `${response.tgBotToken.slice(0, 20)}******` : null;
		response.webhookSecret = response.webhookSecret ? `${response.webhookSecret.slice(0, 6)}******` : null;
		response.linuxdoClientSecret = response.linuxdoClientSecret ? `${response.linuxdoClientSecret.slice(0, 6)}******` : null;
		response.githubClientSecret = response.githubClientSecret ? `${response.githubClientSecret.slice(0, 6)}******` : null;
		response.googleClientSecret = response.googleClientSecret ? `${response.googleClientSecret.slice(0, 6)}******` : null;
		response.hasR2 = !!c.env.r2
		response.hasCfEmail = !!c.env.email

		let regVerifyOpen = false
		let addVerifyOpen = false

		recordList.forEach(row => {
			if (row.type === verifyRecordType.REG) {
				regVerifyOpen = row.count >= response.regVerifyCount
			}
			if (row.type === verifyRecordType.ADD) {
				addVerifyOpen = row.count >= response.addVerifyCount
			}
		})

		response.regVerifyOpen = regVerifyOpen
		response.addVerifyOpen = addVerifyOpen

		response.storageType = await r2Service.storageType(c);

		return response;
	},

	async set(c, params) {
		const settingData = await this.query(c);
		const secretFields = ['siteKey','secretKey','r2Domain','s3AccessKey','s3SecretKey','tgBotToken','webhookSecret','linuxdoClientSecret','githubClientSecret','googleClientSecret'];
		params = { ...params };
		for (const field of secretFields) if (params[field] === undefined || (typeof params[field] === 'string' && params[field].endsWith('******'))) delete params[field];
		let resendTokens = { ...settingData.resendTokens, ...params.resendTokens };
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain]) delete resendTokens[domain];
		});

		if (Array.isArray(params.emailPrefixFilter)) {
			params.emailPrefixFilter = params.emailPrefixFilter + '';
		}

		if (Array.isArray(params.aiCodeFilter)) {
			params.aiCodeFilter = params.aiCodeFilter + '';
		}

		if (params.webhookUrl !== undefined) {
			params.webhookUrl = domainUtils.toOssDomain(params.webhookUrl) || '';
		}

		params.resendTokens = JSON.stringify(resendTokens);

		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	async deleteBackground(c) {

		const { background } = await this.query(c);
		if (!background) return

		if (background.startsWith('http')) {
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
			return;
		}

		if (background) {
			await r2Service.delete(c,background)
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
		}
	},

	async setBackground(c, params) {

		let { background } = params

		await this.deleteBackground(c);

		if (background && !background.startsWith('http')) {

			const file = fileUtils.base64ToFile(background)

			const arrayBuffer = await file.arrayBuffer();
			background = constant.BACKGROUND_PREFIX + await fileUtils.getBuffHash(arrayBuffer) + fileUtils.getExtFileName(file.name);


			await r2Service.putObj(c, background, arrayBuffer, {
				contentType: file.type,
				cacheControl: `public, max-age=31536000, immutable`,
				contentDisposition: `inline; filename="${file.name}"`
			});

		}

		await orm(c).update(setting).set({ background }).run();
		await this.refresh(c);
		return background;
	},


	async setBlacklist(c, params) {
		const { blackSubject, blackContent, blackFrom  } = params
		await orm(c).update(setting).set({ blackSubject, blackContent, blackFrom }).run();
		await this.refresh(c);
		return this.get(c);
	},

	async websiteConfig(c) {

		const settingRow = await this.get(c, true);
		const token = await userContext.getToken(c);

		return {
			register: settingRow.register,
			title: settingRow.title,
			manyEmail: settingRow.manyEmail,
			addEmail: settingRow.addEmail,
			autoRefresh: settingRow.autoRefresh,
			addEmailVerify: settingRow.addEmailVerify,
			registerVerify: settingRow.registerVerify,
			send: settingRow.send,
			r2Domain: settingRow.r2Domain,
			siteKey: settingRow.siteKey,
			background: settingRow.background,
			loginOpacity: settingRow.loginOpacity,
			domainList: settingRow.loginDomain === 1 && !token ? [] : settingRow.domainList,
			regKey: settingRow.regKey,
			regVerifyOpen: settingRow.regVerifyOpen,
			addVerifyOpen: settingRow.addVerifyOpen,
			noticeTitle: settingRow.noticeTitle,
			noticeContent: settingRow.noticeContent,
			noticeType: settingRow.noticeType,
			noticeDuration: settingRow.noticeDuration,
			noticePosition: settingRow.noticePosition,
			noticeWidth: settingRow.noticeWidth,
			noticeOffset: settingRow.noticeOffset,
			notice: settingRow.notice,
			loginDomain: settingRow.loginDomain,
			linuxdoClientId: settingRow.linuxdoClientId,
			linuxdoSwitch: settingRow.linuxdoSwitch,
			githubClientId: settingRow.githubClientId,
			githubSwitch: settingRow.githubSwitch,
			googleClientId: settingRow.googleClientId,
			googleSwitch: settingRow.googleSwitch,
			webhookStatus: settingRow.webhookStatus,
			autoCleanDays: settingRow.autoCleanDays,
			minEmailPrefix: settingRow.minEmailPrefix,
			projectLink: settingRow.projectLink
		};
	},

};

export default settingService;
