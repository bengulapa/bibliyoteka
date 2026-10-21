/**
 * Store operations: import (with auto-merge), dedupe review, tagging,
 * search, soft-delete and undo.
 *
 * Invariant: nothing is ever hard-deleted outside of `purge`.
 */

import type { DB } from './db.ts';
import { logUndo, reindexFts } from './db.ts';
import { normalizeUrl, nearDuplicateKey } from './core/normalize.ts';
import { assessUrl, hostMatchesList } from './core/sensitive.ts';
import { autoTags, type KeywordRule } from './core/tagging.ts';
import type { RawBookmark } from './core/importers/netscape.ts';

export interface BookmarkRow {
  id: number;
  url: string;
  normalized_url: string;
  title: string;
  description: string;
  folder_path: string;
  source: string;
  added_at: string | null;
  private: number;
  private_reasons: string;
  state: string;
  check_status: string;
  last_checked_at: string | null;
  last_good_at: string | null;
  consecutive_failures: number;
}

export function tagId(db: DB, name: string): number {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number };
  return Number(row.id);
}

export function addTag(db: DB, bookmarkId: number, name: string, runId?: number): void {
  const tid = tagId(db, name);
  const existing = db
    .prepare('SELECT 1 AS x FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?')
    .get(bookmarkId, tid);
  if (existing) return;
  db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').run(bookmarkId, tid);
  if (runId) logUndo(db, runId, 'bookmark_tags', bookmarkId, 'insert', { bookmark_id: bookmarkId, tag_id: tid });
}

export function removeTag(db: DB, bookmarkId: number, name: string): void {
  const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?').run(bookmarkId, row.id);
}

export function tagsOf(db: DB, bookmarkId: number): string[] {
  return (
    db
      .prepare('SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ? ORDER BY t.name')
      .all(bookmarkId) as { name: string }[]
  ).map((r) => r.name);
}

export interface ImportResult {
  parsed: number;
  inserted: number;
  merged: number;
  nearDuplicates: number;
  privateFlagged: number;
}

/**
 * Import a batch. Exact-after-normalization duplicates are merged into the
 * existing row: earliest added date wins, tags and folders union.
 * Near-duplicates are recorded for review, never merged automatically.
 */
export function importBookmarks(
  db: DB,
  items: RawBookmark[],
  opts: { source: string; runId: number; rules?: KeywordRule[]; privateDomains?: Set<string> },
): ImportResult {
  const res: ImportResult = { parsed: items.length, inserted: 0, merged: 0, nearDuplicates: 0, privateFlagged: 0 };
  const privateDomains = opts.privateDomains ?? new Set<string>();

  const selByNorm = db.prepare('SELECT * FROM bookmarks WHERE normalized_url = ?');
  const ins = db.prepare(
    `INSERT INTO bookmarks (url, normalized_url, title, description, folder_path, source, added_at, private, private_reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    for (const raw of items) {
      const normalized = normalizeUrl(raw.url);
      if (!normalized) continue;

      const verdict = assessUrl(raw.url);
      const isPrivate = verdict.sensitive || hostMatchesList(raw.url, privateDomains);
      const reasons = [...verdict.reasons, ...(hostMatchesList(raw.url, privateDomains) ? ['private-domain'] : [])];

      const existing = selByNorm.get(normalized) as BookmarkRow | undefined;

      if (existing) {
        // Merge: keep the earliest added date, union the metadata.
        const before = { ...existing };
        const earliest =
          existing.added_at && raw.addedAt
            ? existing.added_at < raw.addedAt
              ? existing.added_at
              : raw.addedAt
            : existing.added_at ?? raw.addedAt;

        db.prepare(
          `UPDATE bookmarks SET
             added_at = ?,
             title = CASE WHEN length(title) >= length(?) THEN title ELSE ? END,
             description = CASE WHEN length(description) > 0 THEN description ELSE ? END,
             folder_path = CASE WHEN length(folder_path) > 0 THEN folder_path ELSE ? END,
             private = CASE WHEN private = 1 OR ? = 1 THEN 1 ELSE 0 END,
             private_reasons = CASE WHEN length(private_reasons) > 0 THEN private_reasons ELSE ? END,
             updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          earliest,
          raw.title,
          raw.title,
          raw.description,
          raw.folderPath,
          isPrivate ? 1 : 0,
          reasons.join(','),
          existing.id,
        );
        logUndo(db, opts.runId, 'bookmarks', existing.id, 'update', before);

        for (const t of autoTags(raw, opts.source, opts.rules)) addTag(db, existing.id, t, opts.runId);
        res.merged++;
        continue;
      }

      ins.run(
        raw.url,
        normalized,
        raw.title,
        raw.description,
        raw.folderPath,
        opts.source,
        raw.addedAt,
        isPrivate ? 1 : 0,
        reasons.join(','),
      );
      const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      logUndo(db, opts.runId, 'bookmarks', id, 'insert');
      for (const t of autoTags(raw, opts.source, opts.rules)) addTag(db, id, t, opts.runId);

      res.inserted++;
      if (isPrivate) res.privateFlagged++;
    }

    res.nearDuplicates = findNearDuplicates(db);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  reindexFts(db);
  return res;
}

/** Same host+path, different query — flagged for human review only. */
export function findNearDuplicates(db: DB): number {
  const rows = db.prepare("SELECT id, url FROM bookmarks WHERE state = 'active'").all() as { id: number; url: string }[];
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const key = nearDuplicateKey(r.url);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r.id);
  }

  const ins = db.prepare('INSERT OR IGNORE INTO duplicate_pairs (a_id, b_id, kind) VALUES (?, ?, ?)');
  let count = 0;
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b);
    for (let i = 1; i < ids.length; i++) {
      ins.run(ids[0], ids[i], 'near');
      count++;
    }
  }
  return count;
}

export function pendingDuplicates(db: DB): any[] {
  return db
    .prepare(
      `SELECT d.id, d.a_id, d.b_id,
              a.url AS a_url, a.title AS a_title,
              b.url AS b_url, b.title AS b_title
         FROM duplicate_pairs d
         JOIN bookmarks a ON a.id = d.a_id
         JOIN bookmarks b ON b.id = d.b_id
        WHERE d.resolved = 0 AND a.state = 'active' AND b.state = 'active'
        ORDER BY d.id`,
    )
    .all();
}

/** Merge b into a: union tags, keep earliest date, archive b. Reversible. */
export function mergeBookmarks(db: DB, keepId: number, dropId: number, runId: number): void {
  const keep = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(keepId) as BookmarkRow;
  const drop = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(dropId) as BookmarkRow;
  if (!keep || !drop) return;

  logUndo(db, runId, 'bookmarks', keepId, 'update', { ...keep });

  const earliest =
    keep.added_at && drop.added_at ? (keep.added_at < drop.added_at ? keep.added_at : drop.added_at) : keep.added_at ?? drop.added_at;
  db.prepare("UPDATE bookmarks SET added_at = ?, updated_at = datetime('now') WHERE id = ?").run(earliest, keepId);

  for (const t of tagsOf(db, dropId)) addTag(db, keepId, t, runId);

  archiveBookmark(db, dropId, runId);

  // Record which review pairs this resolved so undo can re-open them.
  const pairs = db
    .prepare('SELECT id FROM duplicate_pairs WHERE resolved = 0 AND (a_id IN (?, ?) OR b_id IN (?, ?))')
    .all(keepId, dropId, keepId, dropId) as { id: number }[];
  for (const p of pairs) logUndo(db, runId, 'duplicate_pairs', p.id, 'update', { resolved: 0 });

  db.prepare('UPDATE duplicate_pairs SET resolved = 1 WHERE a_id IN (?, ?) OR b_id IN (?, ?)').run(
    keepId,
    dropId,
    keepId,
    dropId,
  );
}

/** Soft delete. Never removes the row. */
export function archiveBookmark(db: DB, id: number, runId: number): void {
  const before = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!before) return;
  logUndo(db, runId, 'bookmarks', id, 'update', before);
  db.prepare("UPDATE bookmarks SET state = 'archived', updated_at = datetime('now') WHERE id = ?").run(id);
  db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?').run(id);
}

export function restoreBookmark(db: DB, id: number): void {
  db.prepare("UPDATE bookmarks SET state = 'active', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function setPrivate(db: DB, id: number, isPrivate: boolean): void {
  db.prepare("UPDATE bookmarks SET private = ?, updated_at = datetime('now') WHERE id = ?").run(isPrivate ? 1 : 0, id);
}

export interface QueryOpts {
  q?: string;
  tag?: string;
  status?: string;
  includePrivate?: boolean;
  state?: string;
  limit?: number;
  offset?: number;
  sort?: 'added' | 'title' | 'url' | 'checked';
}

export function queryBookmarks(db: DB, opts: QueryOpts = {}): BookmarkRow[] {
  const where: string[] = [];
  const params: any[] = [];

  where.push('b.state = ?');
  params.push(opts.state ?? 'active');

  if (!opts.includePrivate) where.push('b.private = 0');

  if (opts.status) {
    where.push('b.check_status = ?');
    params.push(opts.status);
  }

  if (opts.tag) {
    where.push('EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.name = ?)');
    params.push(opts.tag);
  }

  if (opts.q) {
    where.push('(b.title LIKE ? OR b.url LIKE ? OR b.description LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }

  const sortSql =
    opts.sort === 'title'
      ? 'b.title COLLATE NOCASE ASC'
      : opts.sort === 'url'
        ? 'b.url COLLATE NOCASE ASC'
        : opts.sort === 'checked'
          ? 'b.last_checked_at DESC NULLS LAST'
          : "COALESCE(b.added_at, b.created_at) DESC";

  const sql = `SELECT b.* FROM bookmarks b WHERE ${where.join(' AND ')} ORDER BY ${sortSql} LIMIT ? OFFSET ?`;
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  return db.prepare(sql).all(...params) as BookmarkRow[];
}

export function countBookmarks(db: DB, opts: QueryOpts = {}): number {
  const rows = queryBookmarks(db, { ...opts, limit: 1_000_000, offset: 0 });
  return rows.length;
}

export function allTags(db: DB, includePrivate = false): { name: string; count: number }[] {
  return db
    .prepare(
      `SELECT t.name, COUNT(*) AS count
         FROM tags t
         JOIN bookmark_tags bt ON bt.tag_id = t.id
         JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE b.state = 'active' ${includePrivate ? '' : 'AND b.private = 0'}
        GROUP BY t.name
        ORDER BY count DESC, t.name ASC`,
    )
    .all() as { name: string; count: number }[];
}

/** Reverse an entire run. Insert-undo archives; update-undo restores the prior row. */
export function undoRun(db: DB, runId: number): number {
  const entries = db.prepare('SELECT * FROM undo_log WHERE run_id = ? ORDER BY id DESC').all(runId) as any[];
  let n = 0;

  db.exec('BEGIN');
  try {
    for (const e of entries) {
      if (e.table_name === 'bookmarks' && e.op === 'insert') {
        db.prepare('DELETE FROM bookmarks WHERE id = ?').run(e.row_id);
        n++;
      } else if (e.table_name === 'bookmarks' && e.op === 'update' && e.before_json) {
        const b = JSON.parse(e.before_json);
        db.prepare(
          `UPDATE bookmarks SET url=?, normalized_url=?, title=?, description=?, folder_path=?, source=?,
             added_at=?, private=?, private_reasons=?, state=?, check_status=?, last_checked_at=?,
             last_good_at=?, consecutive_failures=? WHERE id = ?`,
        ).run(
          b.url, b.normalized_url, b.title, b.description, b.folder_path, b.source,
          b.added_at, b.private, b.private_reasons, b.state, b.check_status, b.last_checked_at,
          b.last_good_at, b.consecutive_failures, e.row_id,
        );
        n++;
      } else if (e.table_name === 'bookmark_tags' && e.op === 'insert' && e.before_json) {
        const t = JSON.parse(e.before_json);
        db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?').run(t.bookmark_id, t.tag_id);
        n++;
      } else if (e.table_name === 'duplicate_pairs' && e.op === 'update' && e.before_json) {
        const p = JSON.parse(e.before_json);
        db.prepare('UPDATE duplicate_pairs SET resolved = ? WHERE id = ?').run(p.resolved, e.row_id);
        n++;
      }
    }
    db.prepare('UPDATE runs SET undone = 1 WHERE id = ?').run(runId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  reindexFts(db);
  return n;
}
