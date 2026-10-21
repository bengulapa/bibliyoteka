# Bookmark manager

A local-first bookmark manager with a web GUI. Import your browser or read-later
exports, deduplicate them, tag and organize them, and check which links still
work — without getting your IP treated as a bot.

Everything stays on your machine. No account, no cloud, no telemetry, and
**zero runtime dependencies**.

```bash
npm start           # open http://localhost:7777
```

Requires Node 24+ (it runs the TypeScript sources directly — there is no build step).

## What it does

**Import** — Netscape bookmark HTML (Chrome, Firefox, Edge, Safari) and CSV
exports from read-later services (Pocket, Instapaper, Raindrop), plus its own
JSON backups. Drag a file onto the import dialog and you get a preview of what
will happen *before* anything is written.

**Deduplicate** — URLs are normalized (case, default ports, tracking params like
`utm_*` and `fbclid`, fragments, trailing slashes) before comparison. Exact
matches after normalization are merged automatically, keeping the earliest date
and the union of tags and folders. Near-duplicates — same page, different query
string — are **never** merged automatically; `?id=1001` and `?id=1002` are
usually different products. Those go to a review queue.

**Organize** — Tags are the primary axis. Browser folders are imported as tags
(`folder:dev/rust`) *and* preserved verbatim so exports round-trip back into a
browser. Auto-tagging is deterministic only — `site:`, `src:`, `folder:`, plus
your own keyword rules. No AI, no network calls to classify anything.

**Check links politely** — This is the part most tools get wrong:

- a real browser User-Agent, not a scraper string
- one request per domain every 5–10 seconds, jittered, ~4 domains in parallel
- `robots.txt` and `Retry-After` are honored
- `HEAD` first, falling back to `GET` when a server rejects it
- incremental and resumable; nothing is re-checked within 30 days
- full status *history* per bookmark, not a single boolean

Crucially, **403 / 429 / Cloudflare challenges / TLS errors are recorded as
`unknown`, never as `dead`.** Being blocked is not evidence a page is gone. A
link is only marked dead after repeated genuine 404/410/DNS failures, and even
then it is flagged for review with a Wayback Machine link — never removed.

A TLS error such as `tls-error:SELF_SIGNED_CERT_IN_CHAIN` almost always means
you're on a network with a TLS-inspecting proxy/firewall (common on corporate
networks), whose root CA isn't in Node's trust store — not that the site is
broken. Two ways to fix it:

- **Trust your corporate CA (recommended):** set `NODE_EXTRA_CA_CERTS` to the
  path of your org's root CA `.pem` file before running `bm serve`, so checks
  verify certificates properly instead of just giving up.
- **"Ignore certificate errors" checkbox** on the Link check screen: an
  explicit opt-in that skips certificate verification for that run only. Only
  use it on networks you trust — it weakens the integrity of the check.

After a run finishes, the Link check screen shows a persistent summary
(checked/alive/dead/unknown/skipped counts, plus any links that returned a
404/410) — it doesn't rely on a toast you might miss.

**Handle sensitive URLs** — Password-reset links, signed URLs, session tokens,
`localhost`/RFC1918 addresses and URLs with embedded credentials are detected on
import and flagged private. Private bookmarks are hidden from default views and
search, excluded from exports unless you explicitly opt in, never fetched by the
link checker, and redacted in logs and in the UI. You can also mark whole
domains private in Settings.

**Nothing is ever deleted.** "Archive" soft-hides. Every operation is recorded
as a run and can be undone from the toast or from Settings → History.

**Export** — Netscape HTML (rebuilds the folder tree, re-importable into any
browser) or JSON for a lossless backup.

## Architecture

Three layers, so this can become a browser extension or desktop app without a
rewrite:

| Layer | Path | Depends on |
|---|---|---|
| Core logic | `src/core/` | nothing — plain TypeScript and standard `fetch` |
| JSON API | `src/api.ts` | core + a storage handle |
| Shell | `src/web/` | Node HTTP + SQLite |

`src/core/` holds parsing, URL normalization, dedupe rules, sensitivity
detection, tagging, and the polite fetcher. It runs anywhere JavaScript runs.

`src/api.ts` is transport-agnostic: it takes `{method, path, query, body}` and
returns `{status, body, download?}`. The web server mounts it over HTTP; an
extension background worker or a desktop shell can call `handle()` in-process
instead, with no logic changes.

The frontend (`src/web/public/`) is vanilla HTML/CSS/JS — no framework, no
bundler, no build step.

> **Not yet abstracted:** `api.ts` takes a Node `node:sqlite` handle directly. A
> browser-only build would need an IndexedDB adapter behind a shared store
> interface. That is the single remaining blocker for the extension target.

## CLI

The GUI is the primary interface and can do everything. The CLI is kept for
scripting and automation:

```bash
npm run bm -- import bookmarks.html
npm run bm -- check --limit 100
npm run bm -- export bookmarks.html
npm run bm -- undo
```

Run `npm run bm -- --help` for the full list.

## Storage

A single SQLite file at `~/.bookmarks/db.sqlite`. Override the location with
`BM_HOME`. Back it up by copying the file, or by exporting JSON.

Data at rest is protected by filesystem permissions and the `private` flag;
full-database encryption is deliberately out of scope for now.

The server binds to `127.0.0.1` only.

## Planned

Article text extraction to markdown with YAML front-matter. The schema already
reserves `article_text`, `extracted_at`, and `extraction_status`, and it will
reuse the same polite fetch layer — so it lands as a feature, not a migration.

## Tests

```bash
npm test
```

Covers URL normalization, dedupe semantics, importers, the privacy guarantees,
undo, the full API route table, and an end-to-end run through the HTTP server.
