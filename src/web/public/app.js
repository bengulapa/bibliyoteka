/**
 * Bookmark manager UI. Vanilla ES modules — no framework, no build step.
 * All state changes go through the JSON API in ../api.ts.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  view: 'library',
  q: '',
  tag: '',
  status: '',
  sort: 'added',
  includePrivate: false,
  showArchived: false,
  offset: 0,
  limit: 100,
  selected: new Set(),
  bookmarks: [],
  hasMore: false,
};

// ---------------------------------------------------------------- utilities

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function toast(message, { error = false, undo = false } = {}) {
  const box = el('div', { class: `toast${error ? ' err' : ''}` }, message);
  if (undo) {
    box.append(
      el('button', {
        text: 'Undo',
        onclick: async () => {
          box.remove();
          const r = await api('POST', '/api/undo', {});
          toast(`Undone — ${r.reversed} change(s) reversed.`);
          await refreshAll();
        },
      }),
    );
  }
  $('#toasts').append(box);
  setTimeout(() => box.remove(), undo ? 12000 : 5000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

/** Wrap an action so failures surface as a toast rather than a silent no-op. */
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString() : '—');

// ------------------------------------------------------------------ library

function bookmarkRow(b) {
  const checkbox = el('input', {
    type: 'checkbox',
    checked: state.selected.has(b.id),
    onchange: (e) => {
      e.target.checked ? state.selected.add(b.id) : state.selected.delete(b.id);
      renderSelection();
    },
  });

  const badges = [];
  if (b.private) badges.push(el('span', { class: 'badge private', title: b.privateReasons.join(', ') }, 'private'));
  if (b.checkStatus && b.checkStatus !== 'unchecked') {
    badges.push(
      el(
        'span',
        {
          class: `badge ${b.checkStatus}`,
          title:
            b.checkStatus === 'unknown'
              ? 'The site blocked or refused the check — this is not proof the link is dead.'
              : `Last checked ${fmtDate(b.lastCheckedAt)}`,
        },
        b.checkStatus,
      ),
    );
  }
  if (b.wayback) {
    badges.push(el('a', { class: 'tag', href: b.wayback, target: '_blank', rel: 'noreferrer' }, 'Wayback ↗'));
  }

  const tags = b.tags.map((t) =>
    el(
      'span',
      { class: 'tag', title: `Filter by ${t}` },
      el('span', { onclick: () => { state.tag = t; state.offset = 0; loadBookmarks(); } }, t),
      el('span', {
        class: 'x',
        title: `Remove ${t}`,
        onclick: () => guard(async () => {
          await api('POST', '/api/tags/remove', { ids: [b.id], tag: t });
          loadBookmarks();
        }),
      }, '×'),
    ),
  );

  // Private URLs are shown redacted but remain clickable via the real href.
  const link = el('a', { class: 'title', href: b.url, target: '_blank', rel: 'noreferrer' }, b.title || b.displayUrl);

  const actions = [
    el('button', {
      text: b.private ? 'Unmark private' : 'Private',
      onclick: () => guard(async () => {
        await api('POST', '/api/private', { ids: [b.id], value: !b.private });
        loadBookmarks();
      }),
    }),
    b.state === 'archived'
      ? el('button', {
          text: 'Restore',
          onclick: () => guard(async () => {
            await api('POST', '/api/restore', { ids: [b.id] });
            loadBookmarks();
          }),
        })
      : el('button', {
          class: 'danger',
          text: 'Archive',
          title: 'Hidden from the library, never deleted.',
          onclick: () => guard(async () => {
            await api('POST', '/api/archive', { ids: [b.id] });
            toast(`Archived “${b.title}”.`, { undo: true });
            loadBookmarks();
          }),
        }),
  ];

  return el(
    'div',
    { class: `item${b.state === 'archived' ? ' archived' : ''}` },
    checkbox,
    el(
      'div',
      {},
      link,
      el('div', { class: 'url' }, b.displayUrl),
      b.description ? el('div', { class: 'desc' }, b.description) : null,
      el('div', { class: 'meta' }, ...badges, ...tags, el('span', { class: 'muted' }, `added ${fmtDate(b.addedAt)}`)),
    ),
    el('div', { class: 'actions' }, ...actions),
  );
}

function renderSelection() {
  const n = state.selected.size;
  $('#selection-count').textContent = n ? `${n} selected` : 'none selected';
  $('#bulk').hidden = n === 0;
}

function renderActiveFilters() {
  const box = $('#active-filters');
  box.replaceChildren();
  const chip = (label, clear) =>
    box.append(el('span', { class: 'tag', onclick: () => { clear(); state.offset = 0; loadBookmarks(); } }, `${label} ×`));

  if (state.q) chip(`search: ${state.q}`, () => { state.q = ''; $('#search').value = ''; });
  if (state.tag) chip(`tag: ${state.tag}`, () => (state.tag = ''));
  if (state.status) chip(`status: ${state.status}`, () => {
    state.status = '';
    $$('#status-filters .side').forEach((b) => b.classList.toggle('on', !b.dataset.status));
  });
}

async function loadBookmarks() {
  const p = new URLSearchParams({
    q: state.q,
    tag: state.tag,
    status: state.status,
    sort: state.sort,
    state: state.showArchived ? 'archived' : 'active',
    limit: String(state.limit),
    offset: String(state.offset),
  });
  if (state.includePrivate) p.set('private', '1');

  const data = await guard(() => api('GET', `/api/bookmarks?${p}`));
  if (!data) return;

  state.bookmarks = data.bookmarks;
  state.hasMore = data.hasMore;

  const list = $('#list');
  list.replaceChildren();
  if (!data.bookmarks.length) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        state.q || state.tag || state.status
          ? 'No bookmarks match these filters.'
          : 'No bookmarks yet — use Import to load a browser or read-later export.',
      ),
    );
  } else {
    for (const b of data.bookmarks) list.append(bookmarkRow(b));
  }

  const pager = $('#pager');
  pager.replaceChildren();
  if (data.bookmarks.length) {
    if (state.offset > 0) {
      pager.append(el('button', {
        text: '← Previous',
        onclick: () => { state.offset = Math.max(0, state.offset - state.limit); loadBookmarks(); },
      }));
    }
    pager.append(el('span', { class: 'muted' }, `${state.offset + 1}–${state.offset + data.bookmarks.length}`));
    if (data.hasMore) {
      pager.append(el('button', {
        text: 'Next →',
        onclick: () => { state.offset += state.limit; loadBookmarks(); },
      }));
    }
  }

  renderActiveFilters();
  renderSelection();
}

// ------------------------------------------------------------- sidebar data

async function loadStats() {
  const s = await guard(() => api('GET', '/api/stats'));
  if (!s) return;

  $('#stats').replaceChildren(
    el('div', {}, el('b', {}, String(s.active)), ' bookmarks'),
    el('div', {}, el('b', {}, String(s.tags)), ' tags'),
    el('div', {}, el('b', {}, String(s.private)), ' private'),
    el('div', {}, el('b', {}, String(s.archived)), ' archived'),
    el('div', { class: 'muted' }, `${s.dueForCheck} due for check`),
  );

  const pill = $('#pill-dupes');
  pill.hidden = s.duplicates === 0;
  pill.textContent = String(s.duplicates);
}

async function loadTags() {
  const data = await guard(() => api('GET', `/api/tags${state.includePrivate ? '?private=1' : ''}`));
  if (!data) return;

  const needle = $('#tag-filter').value.toLowerCase();
  const box = $('#tags');
  box.replaceChildren();
  for (const t of data.tags) {
    if (needle && !t.name.toLowerCase().includes(needle)) continue;
    box.append(
      el('button', {
        class: `side${state.tag === t.name ? ' on' : ''}`,
        onclick: () => {
          state.tag = state.tag === t.name ? '' : t.name;
          state.offset = 0;
          loadTags();
          loadBookmarks();
        },
      }, `${t.name} (${t.count})`),
    );
  }
  if (!box.children.length) box.append(el('div', { class: 'muted' }, 'No tags yet.'));
}

// --------------------------------------------------------------- duplicates

async function loadDuplicates() {
  const data = await guard(() => api('GET', '/api/duplicates'));
  if (!data) return;

  const box = $('#dupes');
  box.replaceChildren();
  if (!data.pairs.length) {
    box.append(el('div', { class: 'empty' }, 'Nothing to review. Exact duplicates were merged automatically on import.'));
    return;
  }

  for (const p of data.pairs) {
    const card = (side, other) =>
      el(
        'div',
        { class: 'side-card' },
        el('div', {}, el('a', { class: 'title', href: side.url, target: '_blank', rel: 'noreferrer' }, side.title || side.url)),
        el('div', { class: 'url' }, side.url),
        el('div', { class: 'row' },
          el('button', {
            text: 'Keep this one',
            onclick: () => guard(async () => {
              await api('POST', '/api/merge', { keep: side.id, drop: other.id });
              toast('Merged — tags and folders were combined.', { undo: true });
              await Promise.all([loadDuplicates(), loadStats()]);
            }),
          }),
        ),
      );

    box.append(
      el(
        'div',
        { class: 'dupe' },
        el('div', { class: 'muted' }, 'Same page, different query string — review before merging.'),
        el('div', { class: 'pair' }, card(p.a, p.b), card(p.b, p.a)),
        el('button', {
          text: 'Keep both (not duplicates)',
          onclick: () => guard(async () => {
            await api('POST', '/api/duplicates/keep-both', { pair: p.id });
            await Promise.all([loadDuplicates(), loadStats()]);
          }),
        }),
      ),
    );
  }
}

// --------------------------------------------------------------- link check

let checkStream = null;

function startCheck() {
  const p = new URLSearchParams({ limit: $('#check-limit').value || '50' });
  if ($('#check-private').checked) p.set('private', '1');
  if ($('#check-force').checked) p.set('recheckDays', '0');
  if ($('#check-fast').checked) p.set('fast', '1');

  const log = $('#check-log');
  log.replaceChildren();
  log.hidden = false;
  $('#check-progress').hidden = false;
  $('#check-bar').style.width = '0%';
  $('#check-start').hidden = true;
  $('#check-stop').hidden = false;

  checkStream = new EventSource(`/api/check/stream?${p}`);

  checkStream.addEventListener('start', (e) => {
    const { due } = JSON.parse(e.data);
    // Be explicit that politeness, not slowness, drives the duration.
    const mins = Math.round((due * 7) / 60);
    $('#check-eta').textContent = due
      ? `Checking ${due} link(s) — roughly ${mins || '<1'} min at a polite rate.`
      : 'Nothing is due for a check right now.';
  });

  checkStream.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    $('#check-bar').style.width = `${Math.round((p.done / Math.max(p.total, 1)) * 100)}%`;
    log.prepend(el('div', { class: p.verdict }, `${p.verdict.padEnd(8)} ${p.status ?? '---'}  ${p.url}${p.note ? `  (${p.note})` : ''}`));
  });

  checkStream.addEventListener('done', (e) => {
    const { summary } = JSON.parse(e.data);
    toast(`Check finished — ${summary.alive} alive, ${summary.dead} dead, ${summary.unknown} unknown.`);
    stopCheck();
    refreshAll();
  });

  checkStream.addEventListener('error', () => {
    // EventSource fires this on normal stream close too, so only warn mid-run.
    if (checkStream && checkStream.readyState === EventSource.CLOSED) stopCheck();
  });
}

function stopCheck() {
  if (checkStream) {
    checkStream.close();
    checkStream = null;
  }
  $('#check-start').hidden = false;
  $('#check-stop').hidden = true;
}

// ----------------------------------------------------------------- settings

/** Run summaries are stored as JSON for imports; show them as prose. */
function describeRun(summary) {
  if (!summary) return '';
  try {
    const s = JSON.parse(summary);
    if (typeof s !== 'object' || s === null) return String(summary);
    const parts = [];
    if (s.inserted != null) parts.push(`${s.inserted} added`);
    if (s.merged) parts.push(`${s.merged} merged`);
    if (s.nearDuplicates) parts.push(`${s.nearDuplicates} flagged`);
    if (s.privateFlagged) parts.push(`${s.privateFlagged} private`);
    return parts.join(', ') || String(summary);
  } catch {
    return String(summary);
  }
}

async function loadSettings() {
  const data = await guard(() => api('GET', '/api/settings'));
  if (!data) return;

  const rules = $('#rules');
  rules.replaceChildren();
  if (!data.rules.length) rules.append(el('div', { class: 'muted' }, 'No custom rules. Site, source, and folder tags are always applied.'));
  data.rules.forEach((r, i) => {
    rules.append(
      el('div', { class: 'row' },
        el('code', {}, r.match),
        el('span', { class: 'muted' }, '→'),
        el('span', { class: 'tag' }, r.tag),
        el('button', {
          text: 'Remove',
          onclick: () => guard(async () => { await api('POST', '/api/settings/rules', { remove: i }); loadSettings(); }),
        }),
      ),
    );
  });

  const pd = $('#private-domains');
  pd.replaceChildren();
  if (!data.privateDomains.length) pd.append(el('div', { class: 'muted' }, 'No domains marked private.'));
  for (const d of data.privateDomains) {
    pd.append(
      el('div', { class: 'row' },
        el('code', {}, d),
        el('button', {
          text: 'Remove',
          onclick: () => guard(async () => { await api('POST', '/api/settings/private-domains', { remove: d }); loadSettings(); }),
        }),
      ),
    );
  }

  const runs = await guard(() => api('GET', '/api/runs'));
  const box = $('#runs');
  box.replaceChildren();
  for (const r of runs?.runs ?? []) {
    box.append(
      el('div', { class: 'row' },
        el('span', { class: 'muted' }, `#${r.id} ${r.kind} · ${fmtDate(r.startedAt)}`),
        el('span', {}, describeRun(r.summary)),
        r.undone
          ? el('span', { class: 'muted' }, 'undone')
          : el('button', {
              text: 'Undo',
              onclick: () => guard(async () => {
                const res = await api('POST', '/api/undo', { runId: r.id });
                toast(`Undone — ${res.reversed} change(s) reversed.`);
                await refreshAll();
                loadSettings();
              }),
            }),
      ),
    );
  }
}

// ------------------------------------------------------------------- import

let pendingUpload = null;

async function previewFile(file) {
  const text = await file.text();
  pendingUpload = { filename: file.name, text };

  const preview = $('#import-preview');
  preview.hidden = false;
  preview.replaceChildren(el('div', { class: 'muted' }, 'Reading…'));

  const data = await guard(() => api('POST', '/api/import', { filename: file.name, text, dryRun: true }));
  if (!data) {
    preview.replaceChildren();
    preview.hidden = true;
    return;
  }

  preview.replaceChildren(
    el('div', { class: 'row' },
      el('strong', {}, `${data.parsed} bookmarks`),
      el('span', { class: 'muted' }, `detected format: ${data.format}`),
    ),
    data.wouldFlagPrivate
      ? el('div', { class: 'warn' }, `${data.wouldFlagPrivate} will be flagged private and hidden by default.`)
      : null,
    el('div', { class: 'list' }, ...data.sample.map((s) =>
      el('div', { class: 'item' },
        el('span', {}),
        el('div', {},
          el('div', { class: 'title' }, s.title),
          el('div', { class: 'url' }, s.url),
          s.folderPath ? el('div', { class: 'meta' }, el('span', { class: 'tag' }, s.folderPath)) : null,
        ),
        el('div', {}, s.private ? el('span', { class: 'badge private' }, 'private') : ''),
      ),
    )),
    el('div', { class: 'muted' }, 'Exact duplicates merge automatically; near-duplicates go to the review queue.'),
  );
  $('#import-confirm').disabled = false;
}

// ---------------------------------------------------------------- app wiring

async function refreshAll() {
  await Promise.all([loadStats(), loadTags(), loadBookmarks()]);
  if (state.view === 'duplicates') loadDuplicates();
}

function showView(name) {
  state.view = name;
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === 'duplicates') loadDuplicates();
  if (name === 'settings') loadSettings();
}

function wire() {
  $$('.nav').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.offset = 0;
      loadBookmarks();
    }, 200);
  });

  $$('#status-filters .side').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#status-filters .side').forEach((o) => o.classList.remove('on'));
      b.classList.add('on');
      state.status = b.dataset.status;
      state.offset = 0;
      loadBookmarks();
    }),
  );

  $('#toggle-private').addEventListener('click', (e) => {
    state.includePrivate = !state.includePrivate;
    e.target.classList.toggle('on', state.includePrivate);
    e.target.textContent = state.includePrivate ? 'Hide private' : 'Show private';
    state.offset = 0;
    loadTags();
    loadBookmarks();
  });

  $('#toggle-archived').addEventListener('click', (e) => {
    state.showArchived = !state.showArchived;
    e.target.classList.toggle('on', state.showArchived);
    e.target.textContent = state.showArchived ? 'Hide archived' : 'Show archived';
    state.offset = 0;
    loadBookmarks();
  });

  $('#tag-filter').addEventListener('input', loadTags);
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; state.offset = 0; loadBookmarks(); });

  // ---- bulk actions ----
  $('#select-all').addEventListener('change', (e) => {
    state.selected = e.target.checked ? new Set(state.bookmarks.map((b) => b.id)) : new Set();
    loadBookmarks();
  });

  const ids = () => [...state.selected];

  $('#bulk-tag-add').addEventListener('click', () => guard(async () => {
    const tag = $('#bulk-tag').value.trim();
    if (!tag) return;
    await api('POST', '/api/tags/add', { ids: ids(), tag });
    $('#bulk-tag').value = '';
    toast(`Tagged ${ids().length} bookmark(s) with “${tag}”.`, { undo: true });
    state.selected.clear();
    await refreshAll();
  }));

  $('#bulk-private').addEventListener('click', () => guard(async () => {
    await api('POST', '/api/private', { ids: ids(), value: true });
    toast(`${ids().length} marked private.`);
    state.selected.clear();
    await refreshAll();
  }));

  $('#bulk-archive').addEventListener('click', () => guard(async () => {
    const n = ids().length;
    await api('POST', '/api/archive', { ids: ids() });
    toast(`Archived ${n} bookmark(s). Nothing was deleted.`, { undo: true });
    state.selected.clear();
    await refreshAll();
  }));

  // ---- export ----
  $('#btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#export-menu').hidden = !$('#export-menu').hidden;
  });
  document.addEventListener('click', () => ($('#export-menu').hidden = true));
  $('#export-menu').addEventListener('click', (e) => e.stopPropagation());

  $$('#export-menu button[data-format]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = new URLSearchParams({ format: b.dataset.format });
      if ($('#export-private').checked) p.set('private', '1');
      if ($('#export-archived').checked) p.set('archived', '1');
      // Let the browser handle the download via Content-Disposition.
      window.location.href = `/api/export?${p}`;
      $('#export-menu').hidden = true;
    }),
  );

  // ---- undo ----
  $('#btn-undo').addEventListener('click', () => guard(async () => {
    const r = await api('POST', '/api/undo', {});
    toast(`Undone run #${r.runId} — ${r.reversed} change(s) reversed.`);
    await refreshAll();
  }));

  // ---- import dialog ----
  const dlg = $('#import-dialog');
  $('#btn-import').addEventListener('click', () => {
    pendingUpload = null;
    $('#import-preview').hidden = true;
    $('#import-confirm').disabled = true;
    $('#file').value = '';
    dlg.showModal();
  });
  $('#import-cancel').addEventListener('click', () => dlg.close());
  $('#file').addEventListener('change', (e) => e.target.files[0] && previewFile(e.target.files[0]));

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }),
  );
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && previewFile(e.dataTransfer.files[0]));

  $('#import-confirm').addEventListener('click', () => guard(async () => {
    if (!pendingUpload) return;
    $('#import-confirm').disabled = true;
    const r = await api('POST', '/api/import', pendingUpload);
    dlg.close();
    toast(
      `Imported ${r.inserted} new, merged ${r.merged} exact duplicate(s), ${r.nearDuplicates} flagged for review, ${r.privateFlagged} marked private.`,
      { undo: true },
    );
    await refreshAll();
  }));

  // ---- add dialog ----
  const add = $('#add-dialog');
  $('#btn-add').addEventListener('click', () => {
    $('#add-url').value = $('#add-title').value = $('#add-tags').value = '';
    $('#add-warning').hidden = true;
    add.showModal();
  });
  $('#add-cancel').addEventListener('click', () => add.close());
  $('#add-confirm').addEventListener('click', () => guard(async () => {
    const url = $('#add-url').value.trim();
    if (!url) return;
    await api('POST', '/api/bookmarks', {
      url,
      title: $('#add-title').value.trim(),
      tags: $('#add-tags').value,
    });
    add.close();
    toast('Bookmark added.', { undo: true });
    await refreshAll();
  }));

  // ---- settings ----
  $('#rule-add').addEventListener('click', () => guard(async () => {
    await api('POST', '/api/settings/rules', { match: $('#rule-match').value, tag: $('#rule-tag').value });
    $('#rule-match').value = $('#rule-tag').value = '';
    loadSettings();
  }));

  $('#pd-save').addEventListener('click', () => guard(async () => {
    await api('POST', '/api/settings/private-domains', { add: $('#pd-add').value });
    $('#pd-add').value = '';
    loadSettings();
    await refreshAll();
  }));

  $('#retag').addEventListener('click', () => guard(async () => {
    const r = await api('POST', '/api/retag', {});
    toast(`Added ${r.added} tag(s) from your rules.`, { undo: true });
    await refreshAll();
  }));

  // ---- link check ----
  $('#check-start').addEventListener('click', startCheck);
  $('#check-stop').addEventListener('click', () => { stopCheck(); toast('Check stopped.'); });
  window.addEventListener('beforeunload', stopCheck);

  // ---- keyboard ----
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

wire();
showView('library');
refreshAll();
