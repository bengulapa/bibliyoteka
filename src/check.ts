/**
 * Link checker. Incremental, resumable, and conservative.
 *
 * Results are recorded as history in `checks`; the bookmark carries only
 * the rolled-up current state. Nothing is ever deleted by a check.
 */

import type { DB } from './db.ts';
import { PoliteFetcher, type PolitenessConfig } from './core/polite.ts';
import { redactUrl } from './core/sensitive.ts';
import { registrableDomain } from './core/normalize.ts';

export interface CheckProgress {
  id: number;
  url: string;
  verdict: 'alive' | 'dead' | 'unknown' | 'skipped';
  status: number | null;
  note: string;
  done: number;
  total: number;
}

export interface CheckOptions {
  limit?: number;
  includePrivate?: boolean;
  recheckAfterDays?: number;
  deadAfterFailures?: number;
  politeness?: Partial<PolitenessConfig>;
  onProgress?: (p: CheckProgress) => void;
  /** Lets a caller abort a run early (e.g. the GUI client disconnected). */
  shouldStop?: () => boolean;
}

export interface CheckSummary {
  checked: number;
  alive: number;
  dead: number;
  unknown: number;
  skipped: number;
}

export function dueForCheck(db: DB, opts: CheckOptions = {}): { id: number; url: string; private: number }[] {
  const days = opts.recheckAfterDays ?? 30;
  // 0 means "force a full recheck" rather than "re-check nothing".
  const window = days > 0 ? "AND (last_checked_at IS NULL OR last_checked_at < datetime('now', ?))" : '';
  const sql = `
    SELECT id, url, private FROM bookmarks
     WHERE state = 'active'
       ${opts.includePrivate ? '' : 'AND private = 0'}
       ${window}
     ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC
     LIMIT ?`;
  const params: any[] = days > 0 ? [`-${days} days`, opts.limit ?? 200] : [opts.limit ?? 200];
  return db.prepare(sql).all(...params) as any[];
}

export async function runCheck(db: DB, opts: CheckOptions = {}): Promise<CheckSummary> {
  const summary: CheckSummary = { checked: 0, alive: 0, dead: 0, unknown: 0, skipped: 0 };
  const deadAfter = opts.deadAfterFailures ?? 3;
  const rows = dueForCheck(db, opts);
  if (!rows.length) return summary;

  const fetcher = new PoliteFetcher(opts.politeness);
  const report = opts.onProgress ?? (() => {});
  const total = rows.length;
  let done = 0;

  // Interleave domains so the per-domain delay is absorbed by other work
  // rather than serializing the whole run behind one busy host.
  const byDomain = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = registrableDomain(r.url) ?? 'unknown';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(r);
  }

  const queues = [...byDomain.values()];
  const workers = Math.min(fetcher.cfg.globalConcurrency, queues.length);
  let cursor = 0;

  const insCheck = db.prepare(
    'INSERT INTO checks (bookmark_id, result, status_code, final_url, note) VALUES (?, ?, ?, ?, ?)',
  );

  const worker = async () => {
    for (;;) {
      const qIndex = cursor++;
      if (qIndex >= queues.length) return;
      for (const row of queues[qIndex]) {
        if (opts.shouldStop?.()) return;
        const res = await fetcher.fetch(row.url);

        insCheck.run(row.id, res.verdict, res.status, res.finalUrl, res.note);
        summary.checked++;

        if (res.verdict === 'alive') {
          summary.alive++;
          db.prepare(
            `UPDATE bookmarks SET check_status='alive', last_checked_at=datetime('now'),
               last_good_at=datetime('now'), consecutive_failures=0 WHERE id = ?`,
          ).run(row.id);
        } else if (res.verdict === 'dead') {
          const fails =
            Number(
              (db.prepare('SELECT consecutive_failures AS f FROM bookmarks WHERE id = ?').get(row.id) as any).f,
            ) + 1;
          const status = fails >= deadAfter ? 'dead' : 'unknown';
          if (status === 'dead') summary.dead++;
          else summary.unknown++;
          db.prepare(
            `UPDATE bookmarks SET check_status=?, last_checked_at=datetime('now'), consecutive_failures=? WHERE id = ?`,
          ).run(status, fails, row.id);
        } else if (res.verdict === 'skipped') {
          summary.skipped++;
          db.prepare("UPDATE bookmarks SET last_checked_at=datetime('now') WHERE id = ?").run(row.id);
        } else {
          summary.unknown++;
          // Blocked or transient: record it, but do not count it against the link.
          db.prepare(
            `UPDATE bookmarks SET check_status='unknown', last_checked_at=datetime('now') WHERE id = ?`,
          ).run(row.id);
        }

        done++;
        report({
          id: row.id,
          // Never emit a live secret, even to a local client.
          url: redactUrl(row.url),
          verdict: res.verdict,
          status: res.status,
          note: res.note,
          done,
          total,
        });      }
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  return summary;
}
