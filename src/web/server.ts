/**
 * Local web UI: server-rendered HTML, no build step, no framework.
 * Curation surface only — destructive work lives in the CLI.
 */

import { createServer } from 'node:http';
import type { DB } from '../db.ts';
import { queryBookmarks, allTags, tagsOf, addTag, removeTag, archiveBookmark, setPrivate, pendingDuplicates, mergeBookmarks } from '../store.ts';
import { startRun, finishRun } from '../db.ts';
import { redactUrl } from '../sensitive.ts';
import { waybackUrl } from '../polite.ts';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;background:#fbfbfa}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e3e3e0;padding:12px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:5}
header h1{font-size:16px;margin:0 16px 0 0;font-weight:600}
input[type=search],input[type=text]{padding:7px 10px;border:1px solid #d6d6d2;border-radius:6px;font-size:14px;min-width:240px}
button{padding:6px 11px;border:1px solid #d6d6d2;background:#fff;border-radius:6px;cursor:pointer;font-size:13px}
button:hover{background:#f2f2ef}
main{display:grid;grid-template-columns:230px 1fr;gap:0;align-items:start}
aside{padding:16px 12px;border-right:1px solid #e3e3e0;position:sticky;top:57px;max-height:calc(100vh - 57px);overflow:auto}
aside a{display:block;padding:3px 8px;border-radius:5px;text-decoration:none;color:#444;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
aside a:hover{background:#efefec}
aside a.on{background:#e7effb;color:#1b4fa0;font-weight:600}
aside h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8a8a84;margin:14px 0 6px 8px}
.list{padding:12px 20px}
.bm{padding:11px 12px;border:1px solid #e9e9e5;border-radius:8px;background:#fff;margin-bottom:8px}
.bm h2{font-size:15px;margin:0 0 3px;font-weight:600}
.bm h2 a{color:#15325e;text-decoration:none}
.bm h2 a:hover{text-decoration:underline}
.url{font-size:12px;color:#7a7a72;word-break:break-all}
.desc{font-size:13px;color:#555;margin-top:5px}
.row{display:flex;gap:7px;align-items:center;margin-top:7px;flex-wrap:wrap}
.tag{font-size:11px;background:#f0f0ec;border-radius:11px;padding:2px 9px;color:#555;text-decoration:none}
.tag:hover{background:#e3e3dd}
.badge{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.alive{background:#e4f5e9;color:#1d6b35}
.dead{background:#fde8e8;color:#9b1c1c}
.unknown{background:#fdf3e2;color:#8a5a0b}
.unchecked{background:#f0f0ec;color:#78786f}
.private{background:#efe6fb;color:#5b2ea6}
.empty{padding:60px 20px;text-align:center;color:#8a8a84}
.pager{display:flex;gap:8px;padding:12px 0}
form.inline{display:inline}
`;

function layout(title: string, tags: { name: string; count: number }[], params: URLSearchParams, body: string): string {
  const q = params.get('q') ?? '';
  const cur = params.get('tag') ?? '';
  const status = params.get('status') ?? '';
  const inc = params.get('private') === '1';

  const link = (name: string, label = name, count?: number) => {
    const p = new URLSearchParams(params);
    p.set('tag', name);
    p.delete('offset');
    return `<a class="${cur === name ? 'on' : ''}" href="/?${p}">${esc(label)}${count !== undefined ? ` <span style="color:#aaa">${count}</span>` : ''}</a>`;
  };

  const statusLink = (s: string, label: string) => {
    const p = new URLSearchParams(params);
    if (s) p.set('status', s);
    else p.delete('status');
    p.delete('offset');
    return `<a class="${status === s ? 'on' : ''}" href="/?${p}">${label}</a>`;
  };

  const clearTag = new URLSearchParams(params);
  clearTag.delete('tag');
  clearTag.delete('offset');

  const togglePriv = new URLSearchParams(params);
  if (inc) togglePriv.delete('private');
  else togglePriv.set('private', '1');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
<header>
  <h1>Bookmarks</h1>
  <form method="get" action="/">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search title, URL, description">
    ${cur ? `<input type="hidden" name="tag" value="${esc(cur)}">` : ''}
    ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
    ${inc ? `<input type="hidden" name="private" value="1">` : ''}
    <button type="submit">Search</button>
  </form>
  <a href="/duplicates"><button type="button">Duplicates</button></a>
  <a href="/?${togglePriv}"><button type="button">${inc ? 'Hide' : 'Show'} private</button></a>
</header>
<main>
  <aside>
    <h3>Status</h3>
    ${statusLink('', 'All')}
    ${statusLink('alive', 'Alive')}
    ${statusLink('dead', 'Dead')}
    ${statusLink('unknown', 'Unknown / blocked')}
    ${statusLink('unchecked', 'Unchecked')}
    <h3>Tags</h3>
    <a class="${cur ? '' : 'on'}" href="/?${clearTag}">All bookmarks</a>
    ${tags.slice(0, 200).map((t) => link(t.name, t.name, t.count)).join('')}
  </aside>
  <div class="list">${body}</div>
</main></body></html>`;
}

export function startServer(db: DB, port = 7777): Promise<number> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const params = url.searchParams;

    const send = (html: string, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const redirect = (to: string) => {
      res.writeHead(302, { Location: to });
      res.end();
    };

    // ---- mutations (curation only) ----
    if (req.method === 'POST') {
      const body = await new Promise<string>((resolve) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => resolve(b));
      });
      const form = new URLSearchParams(body);
      const id = Number(form.get('id'));
      const back = form.get('back') || '/';

      if (url.pathname === '/tag/add' && id) {
        const name = (form.get('tag') ?? '').trim();
        if (name) addTag(db, id, name);
      } else if (url.pathname === '/tag/remove' && id) {
        removeTag(db, id, form.get('tag') ?? '');
      } else if (url.pathname === '/archive' && id) {
        const runId = startRun(db, 'ui-archive');
        archiveBookmark(db, id, runId);
        finishRun(db, runId, `archived ${id}`);
      } else if (url.pathname === '/private' && id) {
        setPrivate(db, id, form.get('value') === '1');
      } else if (url.pathname === '/merge') {
        const keep = Number(form.get('keep'));
        const drop = Number(form.get('drop'));
        if (keep && drop) {
          const runId = startRun(db, 'ui-merge');
          mergeBookmarks(db, keep, drop, runId);
          finishRun(db, runId, `merged ${drop} into ${keep}`);
        }
      } else if (url.pathname === '/duplicate/keep-both') {
        db.prepare('UPDATE duplicate_pairs SET resolved = 1 WHERE id = ?').run(Number(form.get('pair')));
      }
      return redirect(back);
    }

    const tags = allTags(db, params.get('private') === '1');

    // ---- duplicates review queue ----
    if (url.pathname === '/duplicates') {
      const pairs = pendingDuplicates(db);
      const body = pairs.length
        ? pairs
            .map(
              (p: any) => `<div class="bm">
          <div style="font-size:12px;color:#8a8a84;margin-bottom:6px">Near-duplicate — same page, different query string</div>
          <h2><a href="${esc(p.a_url)}" target="_blank" rel="noreferrer">${esc(p.a_title)}</a></h2>
          <div class="url">${esc(p.a_url)}</div>
          <h2 style="margin-top:10px"><a href="${esc(p.b_url)}" target="_blank" rel="noreferrer">${esc(p.b_title)}</a></h2>
          <div class="url">${esc(p.b_url)}</div>
          <div class="row">
            <form class="inline" method="post" action="/merge"><input type="hidden" name="keep" value="${p.a_id}"><input type="hidden" name="drop" value="${p.b_id}"><input type="hidden" name="back" value="/duplicates"><button>Keep first</button></form>
            <form class="inline" method="post" action="/merge"><input type="hidden" name="keep" value="${p.b_id}"><input type="hidden" name="drop" value="${p.a_id}"><input type="hidden" name="back" value="/duplicates"><button>Keep second</button></form>
            <form class="inline" method="post" action="/duplicate/keep-both"><input type="hidden" name="pair" value="${p.id}"><input type="hidden" name="back" value="/duplicates"><button>Keep both</button></form>
          </div></div>`,
            )
            .join('')
        : '<div class="empty">No duplicates awaiting review.</div>';
      return send(layout('Duplicates', tags, params, body));
    }

    // ---- main list ----
    const offset = Number(params.get('offset') ?? 0);
    const limit = 50;
    const includePrivate = params.get('private') === '1';
    const items = queryBookmarks(db, {
      q: params.get('q') ?? undefined,
      tag: params.get('tag') ?? undefined,
      status: params.get('status') ?? undefined,
      includePrivate,
      sort: (params.get('sort') as any) ?? 'added',
      limit: limit + 1,
      offset,
    });

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);

    const body = page.length
      ? page
          .map((b) => {
            const bTags = tagsOf(db, b.id);
            const shown = b.private ? redactUrl(b.url) : b.url;
            const back = `/?${params}`;
            return `<div class="bm">
    <h2><a href="${esc(b.url)}" target="_blank" rel="noreferrer">${esc(b.title || b.url)}</a></h2>
    <div class="url">${esc(shown)}</div>
    ${b.description ? `<div class="desc">${esc(b.description)}</div>` : ''}
    <div class="row">
      <span class="badge ${esc(b.check_status)}">${esc(b.check_status)}</span>
      ${b.private ? `<span class="badge private">private</span>` : ''}
      ${b.check_status === 'dead' ? `<a class="tag" href="${esc(waybackUrl(b.url))}" target="_blank" rel="noreferrer">Wayback copy</a>` : ''}
      ${bTags.map((t) => `<a class="tag" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
    </div>
    <div class="row">
      <form class="inline" method="post" action="/tag/add">
        <input type="hidden" name="id" value="${b.id}"><input type="hidden" name="back" value="${esc(back)}">
        <input type="text" name="tag" placeholder="add tag" style="min-width:120px;font-size:12px;padding:4px 7px">
        <button>Tag</button>
      </form>
      <form class="inline" method="post" action="/private">
        <input type="hidden" name="id" value="${b.id}"><input type="hidden" name="value" value="${b.private ? 0 : 1}"><input type="hidden" name="back" value="${esc(back)}">
        <button>${b.private ? 'Unmark private' : 'Mark private'}</button>
      </form>
      <form class="inline" method="post" action="/archive" onsubmit="return confirm('Archive this bookmark? It stays recoverable.')">
        <input type="hidden" name="id" value="${b.id}"><input type="hidden" name="back" value="${esc(back)}">
        <button>Archive</button>
      </form>
    </div></div>`;
          })
          .join('')
      : '<div class="empty">Nothing here yet. Import an export file with <code>bm import</code>.</div>';

    const prev = new URLSearchParams(params);
    prev.set('offset', String(Math.max(0, offset - limit)));
    const next = new URLSearchParams(params);
    next.set('offset', String(offset + limit));

    const pager = `<div class="pager">
      ${offset > 0 ? `<a href="/?${prev}"><button>&larr; Previous</button></a>` : ''}
      ${hasMore ? `<a href="/?${next}"><button>Next &rarr;</button></a>` : ''}
    </div>`;

    send(layout('Bookmarks', tags, params, body + (page.length ? pager : '')));
  });

  return new Promise((resolve) => {
    // Bind to loopback only: this is a local tool, not a service.
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}
