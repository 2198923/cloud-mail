import { describe, expect, it } from 'vitest';
import { migrateV31ToV33 } from '../src/init/schema-migration';

function database(columns = ['sync_delete']) {
  const state = { columns: new Set(columns), indexes: new Set(), executed: [] };
  return {
    state,
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          if (sql.includes('PRAGMA table_info(setting)')) {
            return { results: [...state.columns].map(name => ({ name })) };
          }
          if (sql.includes('PRAGMA table_info(oauth)')) return { results: [] };
          if (sql.includes("sqlite_master") && sql.includes("type = 'table'")) return { results: [] };
          if (sql.includes("sqlite_master")) {
            return { results: [...state.indexes].map(name => ({ name })) };
          }
          return { results: [] };
        },
        async run() {
          state.executed.push(sql);
          const column = sql.match(/ADD COLUMN (\w+)/i)?.[1];
          if (column) state.columns.add(column);
          const index = sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i)?.[1];
          if (index) state.indexes.add(index);
          return { success: true };
        },
      };
    },
  };
}

describe('controlled v3.1-v3.3 schema migration', () => {
  it('adds missing fields and indexes, then is idempotent', async () => {
    const db = database();
    await migrateV31ToV33(db);
    const firstRunCount = db.state.executed.length;
    await migrateV31ToV33(db);
    expect(firstRunCount).toBeGreaterThan(0);
    expect(db.state.executed.length).toBe(firstRunCount);
    expect(db.state.columns).toEqual(new Set([
      'sync_delete', 'linuxdo_client_id', 'linuxdo_client_secret',
      'github_client_id', 'github_client_secret', 'google_client_id',
      'google_client_secret', 'linuxdo_switch', 'github_switch', 'google_switch',
      'auto_clean_days', 'auto_clean_exclude', 'webhook_url', 'webhook_status',
      'webhook_retry', 'webhook_secret',
    ]));
    expect(db.state.indexes).toContain('idx_email_create_time');
  });

  it('recovers when a partial migration already added some fields', async () => {
    const db = database(['sync_delete', 'github_client_id', 'webhook_url']);
    await migrateV31ToV33(db);
    expect(db.state.columns).toContain('github_client_id');
    expect(db.state.columns).toContain('webhook_url');
    expect(db.state.columns).toContain('google_client_secret');
    expect(db.state.columns).toContain('auto_clean_days');
  });
});
