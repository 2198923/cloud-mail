const d1StateService = {
	async setValue(c, key, value) {
		await c.env.db.prepare(`INSERT INTO app_state (key, value, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
			.bind(key, String(value)).run();
	},

	async getValue(c, key) {
		const row = await c.env.db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first();
		return row?.value ?? null;
	},

	async getValueCompat(c, key, legacyKvKey) {
		const value = await this.getValue(c, key);
		if (value !== null) return value;
		const legacy = await c.env.kv.get(legacyKvKey);
		if (legacy === null || legacy === undefined) return null;
		await this.setValue(c, key, legacy);
		return legacy;
	},

	async incrementDaily(c, kind, day, amount) {
		await c.env.db.prepare(`INSERT INTO daily_counter (kind, day, value, updated_at)
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(kind, day) DO UPDATE SET value = value + excluded.value, updated_at = CURRENT_TIMESTAMP`)
			.bind(kind, day, Number(amount)).run();
	},

	async getDaily(c, kind, day) {
		const row = await c.env.db.prepare('SELECT value FROM daily_counter WHERE kind = ? AND day = ?')
			.bind(kind, day).first();
		return Number(row?.value || 0);
	},

	async setCache(c, key, value) {
		await c.env.db.prepare(`INSERT INTO app_cache (key, value, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
			.bind(key, JSON.stringify(value)).run();
	},

	async getCache(c, key) {
		const row = await c.env.db.prepare('SELECT value FROM app_cache WHERE key = ?').bind(key).first();
		if (!row?.value) return null;
		try { return JSON.parse(row.value); } catch { return null; }
	},

	async cacheKeys(c, prefix) {
		const rows = await c.env.db.prepare('SELECT key FROM app_cache WHERE key LIKE ?').bind(`${prefix}%`).all();
		return (rows?.results || []).map(row => row.key);
	},
};

export default d1StateService;
