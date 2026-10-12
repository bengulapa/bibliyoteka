# bm — a local-first bookmark manager

Imports browser and read-later exports, deduplicates them, organizes them with
tags, and checks whether the links still work **without getting you treated as a
bot** — all on your own machine, in one SQLite file.

Nothing is ever hard-deleted. Nothing is ever sent to a third party.

## Install

Requires Node 24+ (uses built-in TypeScript execution and `node:sqlite`).
There are **no dependencies** and no build step.

```sh
git clone <this repo> && cd bookmark-manager
node src/cli.ts --help
```

Your data lives in `~/.bookmarks/db.sqlite`. Override with `BM_HOME`.

## The round trip

```sh
bm import bookmarks.html --source chrome   # Chrome/Firefox/Edge/Safari export
bm dedupe                                  # review near-duplicates
bm serve                                   # browse + tag at localhost:7777
bm check                                   # verify links, slowly and politely
bm export backup.html                      # re-imports into any browser
bm export backup.json                      # lossless: tags, notes, check history
```

Every destructive command prints an undo handle:

```sh
bm undo 7      # reverse run #7 completely
bm runs        # see what has happened
```

## Importing

| Format | Covers |
|---|---|
| Netscape bookmark HTML | Chrome, Firefox, Edge, Safari, Raindrop, most read-later services |
| CSV | Pocket, Instapaper, Omnivore, anything with a URL column |

Columns are auto-detected. Override them when a file is unusual:

```sh
bm import pocket.csv --map url=Link,title=Name,tags=Labels
bm import anything.html --dry-run      # parse and report, write nothing
```

Browser folders become tags (`folder:dev/rust`) *and* are preserved verbatim, so
an export rebuilds your original folder tree.

## Deduplication

A URL is normalized before comparison: lowercase scheme and host, default ports
dropped, `utm_*`/`fbclid`/other trackers stripped, fragments removed (except SPA
`#!` routes), trailing slash dropped.

- **Exact match after normalization** → merged automatically. The earliest
  `added` date wins; tags and folders are unioned.
- **Same page, different query string** → *flagged for review*, never merged.
  Those are often genuinely different pages (`?id=1001` vs `?id=1002`).

Review them in the UI or with `bm dedupe`.

## Link checking without getting blocked

The default profile is deliberately slow. A bookmark archive has no deadline,
and the failure mode of going fast is a blocked IP.

- A real browser User-Agent and matching headers
- One request per domain every 5–10s, jittered; 4 domains in parallel
- `HEAD` first, falling back to `GET` when a server rejects it
- `robots.txt` and `Retry-After` honored
- Two retries with exponential backoff
- Anything verified in the last 30 days is skipped — runs are incremental and resumable

**Blocked is not dead.** A 403, a 429, a Cloudflare challenge or a TLS
interception are all recorded as `unknown`, never `dead`. A link is only called
dead after repeated genuine 404/410/DNS failures — and even then it is flagged
in a review queue with a Wayback Machine link, never removed.

```sh
bm check --limit 50          # check at most 50 due links
bm check --recheck-days 0    # force a full re-check
```

## Sensitive URLs

Bookmarks are flagged private automatically when the URL contains credentials in
the query string, embedded userinfo, or a private/internal host. You can also
mark any bookmark, or a whole domain, private yourself:

```sh
bm private-domain add internal.corp.example
```

Private bookmarks are:

- hidden from the default list, search results and tag counts
- **never fetched** by the link checker unless you pass `--include-private`
- **excluded from every export** unless you pass `--include-private`
- redacted in logs — and redacted even in an opt-in HTML export, so a live
  token never lands in a file you hand to a browser

At rest, protection is the `private` flag plus filesystem permissions.
Full-database encryption is deliberately not implemented yet.

## Organizing

Tags are the primary axis — many-to-many, hierarchical by naming (`lang/rust`).
Automatic tagging is deterministic only: no LLM, no network calls.

- `site:github.com` from the domain
- `src:chrome` from the import
- `folder:dev/rust` from browser folders
- your own keyword rules:

```sh
bm rules add "rust" lang/rust
bm rules add "/\b(k8s|kubernetes)\b/" infra/k8s     # regex also works
```

## CLI vs UI

Destructive and batch work lives in the CLI, where it is scriptable, logged and
undoable. The web UI is for reading and curating: browse, search, filter by tag
or link status, tag, mark private, archive, and resolve duplicates.

The server binds to `127.0.0.1` only.

## Tests

```sh
node --test test/
```

Covers URL normalization, dedupe and merge semantics, both importers, HTML
round-tripping, sensitive-URL detection and redaction, undo, and the link
checker end to end against a local HTTP server (HEAD→GET fallback, robots,
`Retry-After` backoff, per-domain rate limiting, and the blocked-is-not-dead
guarantee).

## Not built yet

Article extraction to markdown is designed but unimplemented. The schema already
reserves `article_text`, so it lands as a feature rather than a migration: it
will reuse the same polite fetch layer and export one `.md` per article with
YAML front-matter.

Also out of scope for now: browser extension, sync, multi-user, encryption.
