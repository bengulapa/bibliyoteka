/**
 * Export. HTML for interoperability, JSON for fidelity.
 * Private bookmarks are excluded unless explicitly requested, and
 * secrets are redacted in HTML output regardless.
 */

import type { DB } from './db.ts';
import { toNetscapeHtml, type RawBookmark } from './importers/netscape.ts';
import { tagsOf, type BookmarkRow } from './store.ts';
import { redactUrl } from './sensitive.ts';

export interface ExportOpts {
  includePrivate?: boolean;
  includeArchived?: boolean;
}

function rows(db: DB, opts: ExportOpts): BookmarkRow[] {
  const states = opts.includeArchived ? "('active','archived')" : "('active')";
  const priv = opts.includePrivate ? '' : 'AND private = 0';
  return db
    .prepare(`SELECT * FROM bookmarks WHERE state IN ${states} ${priv} ORDER BY folder_path, title COLLATE NOCASE`)
    .all() as BookmarkRow[];
}

export function exportHtml(db: DB, opts: ExportOpts = {}): string {
  const items: RawBookmark[] = rows(db, opts).map((b) => ({
    // Even when private rows are explicitly included, never write a live secret.
    url: b.private ? redactUrl(b.url) : b.url,
    title: b.title,
    description: b.description,
    folderPath: b.folder_path,
    addedAt: b.added_at,
    tags: tagsOf(db, b.id).filter((t) => !t.startsWith('folder:')),
  }));
  return toNetscapeHtml(items);
}

export function exportJson(db: DB, opts: ExportOpts = {}): string {
  const out = rows(db, opts).map((b) => ({
    url: opts.includePrivate ? b.url : b.private ? redactUrl(b.url) : b.url,
    normalizedUrl: b.normalized_url,
    title: b.title,
    description: b.description,
    folderPath: b.folder_path,
    source: b.source,
    addedAt: b.added_at,
    private: !!b.private,
    privateReasons: b.private_reasons ? b.private_reasons.split(',') : [],
    state: b.state,
    tags: tagsOf(db, b.id),
    check: {
      status: b.check_status,
      lastCheckedAt: b.last_checked_at,
      lastGoodAt: b.last_good_at,
      consecutiveFailures: b.consecutive_failures,
      history: db
        .prepare('SELECT checked_at, result, status_code, final_url, note FROM checks WHERE bookmark_id = ? ORDER BY checked_at DESC LIMIT 20')
        .all(b.id),
    },
  }));

  return JSON.stringify(
    { format: 'bookmark-manager/v1', exportedAt: new Date().toISOString(), count: out.length, bookmarks: out },
    null,
    2,
  );
}
