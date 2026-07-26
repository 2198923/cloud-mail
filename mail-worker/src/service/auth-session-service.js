import constant from '../const/constant';

const authSessionService = {
	async create(c, userId, token) {
		const expiresAt = Math.floor(Date.now() / 1000) + constant.TOKEN_EXPIRE;
		await c.env.db.batch([
			c.env.db.prepare(`
				INSERT INTO auth_session (user_id, token, expires_at, created_at)
				VALUES (?, ?, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(token) DO UPDATE SET
					user_id = excluded.user_id,
					expires_at = excluded.expires_at
			`).bind(userId, token, expiresAt),
			c.env.db.prepare(`
				DELETE FROM auth_session
				WHERE user_id = ? AND token NOT IN (
					SELECT token FROM auth_session
					WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 11
				)
			`).bind(userId, userId),
			c.env.db.prepare('DELETE FROM auth_session WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)),
		]);
	},

	async valid(c, userId, token) {
		if (!token) return false;
		const row = await c.env.db.prepare(`
			SELECT 1 AS valid FROM auth_session
			WHERE user_id = ? AND token = ? AND expires_at >= ?
			LIMIT 1
		`).bind(userId, token, Math.floor(Date.now() / 1000)).first();
		if (row?.valid) return true;

		const legacyBlocked = await c.env.db.prepare(`
			SELECT 1 AS blocked FROM auth_session_legacy_block WHERE user_id = ? LIMIT 1
		`).bind(userId).first();
		if (legacyBlocked?.blocked) return false;

		const revoked = await c.env.db.prepare(`
			SELECT 1 AS revoked FROM auth_session_revocation WHERE user_id = ? AND token = ? LIMIT 1
		`).bind(userId, token).first();
		if (revoked?.revoked) return false;

		if (!c.env.kv) return false;
		const legacy = await c.env.kv.get(`auth-uid:${userId}`, { type: 'json' });
		if (!legacy?.tokens?.includes(token)) return false;
		await this.create(c, userId, token);
		return true;
	},

	async remove(c, userId, token) {
		if (!token) return;
		await c.env.db.batch([
			c.env.db.prepare(`INSERT INTO auth_session_revocation (user_id, token, revoked_at)
				VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, token) DO NOTHING`).bind(userId, token),
			c.env.db.prepare('DELETE FROM auth_session WHERE user_id = ? AND token = ?').bind(userId, token),
		]);
	},

	async removeUser(c, userId) {
		await c.env.db.batch([
			c.env.db.prepare(`INSERT INTO auth_session_legacy_block (user_id, blocked_at)
				VALUES (?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET blocked_at = CURRENT_TIMESTAMP`).bind(userId),
			c.env.db.prepare('DELETE FROM auth_session WHERE user_id = ?').bind(userId),
		]);
	},

	async removeUsers(c, userIds) {
		const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return;
		const placeholders = ids.map(() => '?').join(',');
		const values = ids.map(() => '(?, CURRENT_TIMESTAMP)').join(',');
		await c.env.db.batch([
			c.env.db.prepare(`INSERT INTO auth_session_legacy_block (user_id, blocked_at) VALUES ${values}
				ON CONFLICT(user_id) DO UPDATE SET blocked_at = CURRENT_TIMESTAMP`).bind(...ids),
			c.env.db.prepare(`DELETE FROM auth_session WHERE user_id IN (${placeholders})`).bind(...ids),
		]);
	},
};

export default authSessionService;
