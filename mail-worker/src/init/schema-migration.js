const V31_V33_COLUMNS = [
  ['sync_delete', 'INTEGER NOT NULL DEFAULT 0'],
  ['linuxdo_client_id', "TEXT NOT NULL DEFAULT ''"],
  ['linuxdo_client_secret', "TEXT NOT NULL DEFAULT ''"],
  ['github_client_id', "TEXT NOT NULL DEFAULT ''"],
  ['github_client_secret', "TEXT NOT NULL DEFAULT ''"],
  ['google_client_id', "TEXT NOT NULL DEFAULT ''"],
  ['google_client_secret', "TEXT NOT NULL DEFAULT ''"],
  ['linuxdo_switch', 'INTEGER NOT NULL DEFAULT 1'],
  ['github_switch', 'INTEGER NOT NULL DEFAULT 1'],
  ['google_switch', 'INTEGER NOT NULL DEFAULT 1'],
  ['auto_clean_days', 'INTEGER NOT NULL DEFAULT 0'],
  ['auto_clean_exclude', "TEXT NOT NULL DEFAULT ''"],
  ['webhook_url', "TEXT NOT NULL DEFAULT ''"],
  ['webhook_status', 'INTEGER NOT NULL DEFAULT 1'],
  ['webhook_retry', 'INTEGER NOT NULL DEFAULT 0'],
  ['webhook_secret', "TEXT NOT NULL DEFAULT ''"],
];

const V31_V33_INDEXES = [
  ['idx_email_create_time', 'email(create_time)'],
  ['idx_email_list_user', 'email(user_id, type, is_del, email_id)'],
  ['idx_email_list_account', 'email(user_id, account_id, type, is_del, email_id)'],
  ['idx_star_user_email', 'star(user_id, email_id)'],
  ['idx_star_email_user', 'star(email_id, user_id)'],
  ['idx_email_type_id', 'email(type, email_id)'],
  ['idx_user_create_time', 'user(create_time)'],
  ['idx_user_type', 'user(type)'],
  ['idx_attachments_email_type', 'attachments(email_id, type)'],
  ['idx_role_perm_role', 'role_perm(role_id)'],
  ['idx_oauth_oauth_user_id', 'oauth(oauth_user_id)'],
  ['idx_oauth_user_id', 'oauth(user_id)'],
];

async function rows(db, sql) {
  const result = await db.prepare(sql).all();
  return result.results || [];
}

export async function migrateV31ToV33(db) {
  const columns = new Set((await rows(db, 'PRAGMA table_info(setting)')).map(row => row.name));
  for (const [name, definition] of V31_V33_COLUMNS) {
    if (!columns.has(name)) {
      await db.prepare(`ALTER TABLE setting ADD COLUMN ${name} ${definition}`).run();
      columns.add(name);
    }
  }
  const indexes = new Set((await rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'")).map(row => row.name));
  for (const [name, expression] of V31_V33_INDEXES) {
    if (!indexes.has(name)) {
      await db.prepare(`CREATE INDEX IF NOT EXISTS ${name} ON ${expression}`).run();
      indexes.add(name);
    }
  }
}

export { V31_V33_COLUMNS, V31_V33_INDEXES };
