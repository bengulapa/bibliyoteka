#!/usr/bin/env node
/**
 * CLI — owns every batch and destructive operation, so they are
 * scriptable, logged, and undoable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDb, startRun, finishRun, getSetting, setSetting, DB_PATH } from './db.ts';
import { parseNetscapeHtml } from './importers/netscape.ts';
import { parseCsvBookmarks } from './importers/csv.ts';
import { importBookmarks, pendingDuplicates, mergeBookmarks, undoRun, queryBookmarks, allTags, tagsOf, archiveBookmark } from './store.ts';
import { runCheck } from './check.ts';
import { exportHtml, exportJson } from './export.ts';
import { startServer } from './web/server.ts';
import { redactUrl } from './sensitive.ts';
import type { KeywordRule } from './tagging.ts';

const HELP = `
bm — local-first bookmark manager

  bm import <file>        Import bookmarks (.html Netscape export, or .csv)
      --source <name>     Label the import (default: inferred from filename)
      --map url=URL,title=Title,tags=Tags   Override CSV column mapping
      --dry-run           Parse and report without writing

  bm dedupe               Show near-duplicates awaiting review
      --merge <keep> <drop>  Merge one pair (soft-archives the dropped row)

  bm check                Check links politely (slow by default)
      --limit <n>         Max bookmarks this run (default 200)
      --include-private   Also check bookmarks flagged private
      --recheck-days <n>  Skip anything verified within n days (default 30)
      --fast              Shorter delays. Use only on hosts you control.

  bm export <file>        Export to .html (browser-compatible) or .json (lossless)
      --include-private   Include private bookmarks (off by default)
      --include-archived  Include archived bookmarks

  bm list                 List bookmarks
      --tag <t> --status <s> --limit <n> --include-private

  bm tags                 List tags with counts
  bm serve                Start the local web UI (default port 7777)
  bm runs                 Show recent runs
  bm undo [runId]         Undo a run (default: the most recent)
  bm rules                Show keyword auto-tag rules
  bm rules add <match> <tag>
  bm private-domain add <domain>
  bm stats                Summary counts

Database: ${DB_PATH}   (override with BM_HOME)
`;

function loadRules(db: any): KeywordRule[] {
  try {
    return JSON.parse(getSetting(db, 'keyword_rules', '[]'));
  } catch {
    return [];
  }
}

function privateDomains(db: any): Set<string> {
  try {
    return new Set<string>(JSON.parse(getSetting(db, 'private_domains', '[]')));
  } catch {
    return new Set();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      source: { type: 'string' },
      map: { type: 'string' },
      'dry-run': { type: 'boolean' },
      limit: { type: 'string' },
      'include-private': { type: 'boolean' },
      'include-archived': { type: 'boolean' },
      'recheck-days': { type: 'string' },
      fast: { type: 'boolean' },
      tag: { type: 'string' },
      status: { type: 'string' },
      port: { type: 'string' },
      merge: { type: 'boolean' },
    },
  });

  const db = openDb();

  switch (cmd) {
    case 'import': {
      const file = positionals[0];
      if (!file) throw new Error('Usage: bm import <file>');
      const text = readFileSync(file, 'utf8');
      const isCsv = /\.csv$/i.test(file) || (!/<DT|<A\s/i.test(text) && text.includes(','));

      const overrides: Record<string, string> = {};
      for (const pair of String(values.map ?? '').split(',').filter(Boolean)) {
        const [k, v] = pair.split('=');
        if (k && v) overrides[k.trim()] = v.trim();
      }

      const items = isCsv ? parseCsvBookmarks(text, overrides as any) : parseNetscapeHtml(text);
      const source = String(values.source ?? file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));

      if (values['dry-run']) {
        console.log(`Parsed ${items.length} bookmarks from ${file} (${isCsv ? 'CSV' : 'Netscape HTML'}).`);
        for (const b of items.slice(0, 10)) console.log(`  ${b.folderPath ? b.folderPath + '/ ' : ''}${b.title}\n    ${redactUrl(b.url)}`);
        if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);
        return;
      }

      const runId = startRun(db, 'import');
      const res = importBookmarks(db, items, { source, runId, rules: loadRules(db), privateDomains: privateDomains(db) });
      finishRun(db, runId, JSON.stringify(res));

      console.log(`Imported from ${file} (${isCsv ? 'CSV' : 'Netscape HTML'}) — run #${runId}`);
      console.log(`  parsed          ${res.parsed}`);
      console.log(`  new             ${res.inserted}`);
      console.log(`  merged dupes    ${res.merged}`);
      console.log(`  flagged private ${res.privateFlagged}`);
      console.log(`  near-dupes      ${res.nearDuplicates} awaiting review (bm dedupe)`);
      console.log(`\nUndo with: bm undo ${runId}`);
      break;
    }

    case 'dedupe': {
      if (values.merge) {
        const [keep, drop] = positionals.map(Number);
        if (!keep || !drop) throw new Error('Usage: bm dedupe --merge <keepId> <dropId>');
        const runId = startRun(db, 'merge');
        mergeBookmarks(db, keep, drop, runId);
        finishRun(db, runId, `merged ${drop} into ${keep}`);
        console.log(`Merged #${drop} into #${keep}. Undo with: bm undo ${runId}`);
        break;
      }
      const pairs = pendingDuplicates(db);
      if (!pairs.length) {
        console.log('No near-duplicates awaiting review.');
        break;
      }
      console.log(`${pairs.length} near-duplicate pair(s) — same page, different query string:\n`);
      for (const p of pairs) {
        console.log(`  [${p.a_id}] ${p.a_title}\n        ${redactUrl(p.a_url)}`);
        console.log(`  [${p.b_id}] ${p.b_title}\n        ${redactUrl(p.b_url)}`);
        console.log(`        bm dedupe --merge ${p.a_id} ${p.b_id}\n`);
      }
      break;
    }

    case 'check': {
      const summary = await runCheck(db, {
        limit: Number(values.limit ?? 200),
        includePrivate: !!values['include-private'],
        recheckAfterDays: Number(values['recheck-days'] ?? 30),
        politeness: values.fast ? { minDelayMs: 300, maxDelayMs: 900, globalConcurrency: 6 } : {},
        onProgress: (m) => console.log('  ' + m),
      });
      console.log(
        `\nChecked ${summary.checked}: ${summary.alive} alive, ${summary.dead} dead, ${summary.unknown} unknown/blocked, ${summary.skipped} skipped.`,
      );
      if (summary.dead) console.log('Dead links are flagged, never deleted. Review them in the UI with a Wayback link.');
      break;
    }

    case 'export': {
      const file = positionals[0];
      if (!file) throw new Error('Usage: bm export <file.html|file.json>');
      const opts = {
        includePrivate: !!values['include-private'],
        includeArchived: !!values['include-archived'],
      };
      const out = /\.json$/i.test(file) ? exportJson(db, opts) : exportHtml(db, opts);
      writeFileSync(file, out, 'utf8');
      console.log(`Wrote ${file}${opts.includePrivate ? ' (including private)' : ' (private excluded)'}`);
      break;
    }

    case 'list': {
      const rows = queryBookmarks(db, {
        tag: values.tag as string | undefined,
        status: values.status as string | undefined,
        includePrivate: !!values['include-private'],
        limit: Number(values.limit ?? 50),
      });
      for (const b of rows) {
        const t = tagsOf(db, b.id);
        console.log(`[${b.id}] ${b.check_status.padEnd(9)} ${b.title}`);
        console.log(`      ${b.private ? redactUrl(b.url) : b.url}`);
        if (t.length) console.log(`      ${t.join('  ')}`);
      }
      console.log(`\n${rows.length} shown.`);
      break;
    }

    case 'tags': {
      for (const t of allTags(db, !!values['include-private'])) console.log(`${String(t.count).padStart(5)}  ${t.name}`);
      break;
    }

    case 'archive': {
      const id = Number(positionals[0]);
      if (!id) throw new Error('Usage: bm archive <id>');
      const runId = startRun(db, 'archive');
      archiveBookmark(db, id, runId);
      finishRun(db, runId, `archived ${id}`);
      console.log(`Archived #${id} (recoverable). Undo with: bm undo ${runId}`);
      break;
    }

    case 'runs': {
      const rows = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all() as any[];
      for (const r of rows) {
        console.log(`#${r.id}  ${r.kind.padEnd(12)} ${r.started_at}  ${r.undone ? '[undone]' : ''} ${r.summary}`);
      }
      break;
    }

    case 'undo': {
      const id = positionals[0]
        ? Number(positionals[0])
        : Number((db.prepare('SELECT id FROM runs WHERE undone = 0 ORDER BY id DESC LIMIT 1').get() as any)?.id);
      if (!id) throw new Error('Nothing to undo.');
      const n = undoRun(db, id);
      console.log(`Undid run #${id} (${n} change(s) reversed).`);
      break;
    }

    case 'rules': {
      const rules = loadRules(db);
      if (positionals[0] === 'add') {
        const [, match, tag] = positionals;
        if (!match || !tag) throw new Error('Usage: bm rules add <match> <tag>');
        rules.push({ match, tag });
        setSetting(db, 'keyword_rules', JSON.stringify(rules));
        console.log(`Added rule: "${match}" -> ${tag}`);
        break;
      }
      if (!rules.length) console.log('No keyword rules. Add one: bm rules add "rust" lang/rust');
      for (const r of rules) console.log(`  "${r.match}" -> ${r.tag}`);
      break;
    }

    case 'private-domain': {
      const domains = privateDomains(db);
      if (positionals[0] === 'add' && positionals[1]) {
        domains.add(positionals[1].toLowerCase());
        setSetting(db, 'private_domains', JSON.stringify([...domains]));
        console.log(`Marked ${positionals[1]} private. Future imports from it are flagged automatically.`);
        break;
      }
      console.log([...domains].join('\n') || 'No private domains configured.');
      break;
    }

    case 'stats': {
      const row = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM bookmarks WHERE state='active') AS active,
             (SELECT COUNT(*) FROM bookmarks WHERE state='archived') AS archived,
             (SELECT COUNT(*) FROM bookmarks WHERE private=1) AS priv,
             (SELECT COUNT(*) FROM bookmarks WHERE check_status='alive') AS alive,
             (SELECT COUNT(*) FROM bookmarks WHERE check_status='dead') AS dead,
             (SELECT COUNT(*) FROM bookmarks WHERE check_status='unknown') AS unknown,
             (SELECT COUNT(*) FROM bookmarks WHERE check_status='unchecked') AS unchecked,
             (SELECT COUNT(*) FROM tags) AS tags,
             (SELECT COUNT(*) FROM duplicate_pairs WHERE resolved=0) AS dupes`,
        )
        .get() as any;
      console.log(`active      ${row.active}`);
      console.log(`archived    ${row.archived}`);
      console.log(`private     ${row.priv}`);
      console.log(`tags        ${row.tags}`);
      console.log(`dupes open  ${row.dupes}`);
      console.log(`\nlink status: ${row.alive} alive · ${row.dead} dead · ${row.unknown} unknown · ${row.unchecked} unchecked`);
      break;
    }

    case 'serve': {
      const port = Number(values.port ?? 7777);
      await startServer(db, port);
      console.log(`Bookmark UI running at http://localhost:${port}`);
      console.log('Private bookmarks are hidden by default. Ctrl+C to stop.');
      return; // keep the process alive
    }

    default:
      console.log(`Unknown command: ${cmd}`);
      console.log(HELP);
      process.exitCode = 1;
  }

  db.close();
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
