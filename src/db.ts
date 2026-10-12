import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

export const DATA_DIR = process.env.BM_HOME ?? join(homedir(), '.bookmarks');
export const DB_PATH = join(DATA_DIR, 'db.sqlite');

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bookmarks (
  id              INTEGER PRIMARY KEY,
  url             TEXT NOT NULL,
  normalized_url  TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  folder_path     TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT '',
  added_at        TEXT,
  private         INTEGER NOT NULL DEFAULT 0,
  private_reasons TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'active',  -- active | archived
  check_status    TEXT NOT NULL DEFAULT 'unchecked', -- unchecked|alive|dead|unknown
  last_checked_at TEXT,
  last_good_at    TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_norm ON bookmarks(normalized_url);
CREATE INDEX IF NOT EXISTS idx_bm_state ON bookmarks(state);
CREATE INDEX IF NOT EXISTS idx_bm_check ON bookmarks(check_status, last_checked_at);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY,
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  result      TEXT NOT NULL,            -- alive | dead | unknown | skipped
  status_code INTEGER,
  final_url   TEXT,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_checks_bm ON checks(bookmark_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS duplicate_pairs (
  id        INTEGER PRIMARY KEY,
  a_id      INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  b_id      INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,              -- near
  resolved  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (a_id, b_id)
);

-- Reserved now so extraction is a feature later, not a migration.
CREATE TABLE IF NOT EXISTS article_text (
  bookmark_id      INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  markdown         TEXT,
  extracted_at     TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  undone      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS undo_log (
  id        INTEGER PRIMARY KEY,
  run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_id    INTEGER NOT NULL,
  op        TEXT NOT NULL,              -- insert | update | delete
  before_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_undo_run ON undo_log(run_id, id DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A regular (not contentless) FTS table: rows must be deletable when a
-- bookmark is archived, which contentless FTS5 does not allow.
CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  title, url, description, tags
);
`;

export type DB = DatabaseSync;

/** Open a database at an explicit path without touching the user's data dir. */
export function createDbAt(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function openDb(path: string = DB_PATH): DB {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (process.platform !== 'win32') {
    try {
      chmodSync(DATA_DIR, 0o700);
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

export function startRun(db: DB, kind: string): number {
  db.prepare('INSERT INTO runs (kind) VALUES (?)').run(kind);
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get()!.id);
}

export function finishRun(db: DB, runId: number, summary: string): void {
  db.prepare("UPDATE runs SET finished_at = datetime('now'), summary = ? WHERE id = ?").run(summary, runId);
}

export function logUndo(
  db: DB,
  runId: number,
  table: string,
  rowId: number,
  op: 'insert' | 'update' | 'delete',
  before?: unknown,
): void {
  db.prepare('INSERT INTO undo_log (run_id, table_name, row_id, op, before_json) VALUES (?, ?, ?, ?, ?)').run(
    runId,
    table,
    rowId,
    op,
    before === undefined ? null : JSON.stringify(before),
  );
}

export function getSetting(db: DB, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function reindexFts(db: DB): void {
  db.exec('DELETE FROM bookmarks_fts');
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.url, b.description,
              COALESCE((SELECT group_concat(t.name, ' ') FROM bookmark_tags bt
                        JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), '') AS tags
       FROM bookmarks b WHERE b.state = 'active'`,
    )
    .all() as any[];
  const ins = db.prepare('INSERT INTO bookmarks_fts (rowid, title, url, description, tags) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.title ?? '', r.url ?? '', r.description ?? '', r.tags ?? '');
}
