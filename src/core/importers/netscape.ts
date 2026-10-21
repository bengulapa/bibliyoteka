/**
 * Netscape bookmark HTML parser.
 *
 * The shared export format of Chrome, Firefox, Edge, Safari, and most
 * read-later services. Hand-rolled because the format is irregular enough
 * that strict parsers choke on it and simple enough not to need one:
 * folder nesting is implied by <DL> blocks, and <DT>/<DD> are rarely closed.
 */

export interface RawBookmark {
  url: string;
  title: string;
  description: string;
  folderPath: string;
  addedAt: string | null;
  tags: string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function toIso(epoch: string | null): string | null {
  if (!epoch) return null;
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Seconds is the norm; Chrome sometimes emits WebKit microseconds.
  const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseNetscapeHtml(html: string): RawBookmark[] {
  const out: RawBookmark[] = [];
  const folders: string[] = [];
  const lower = html.toLowerCase();

  // Single forward scan over the tokens that carry structure:
  // <H3> opens a folder, </DL> closes one, <A> emits a bookmark,
  // <DD> attaches a description to the bookmark just emitted.
  const tokenRe = /<h3\b|<\/dl\b|<a\b|<dd\b/gi;
  let m: RegExpExecArray | null;
  let last: RawBookmark | null = null;

  while ((m = tokenRe.exec(html)) !== null) {
    const kind = m[0].toLowerCase();
    const tagEnd = html.indexOf('>', m.index);
    if (tagEnd < 0) break;
    const tag = html.slice(m.index, tagEnd + 1);

    if (kind === '<h3') {
      const close = lower.indexOf('</h3', tagEnd);
      folders.push(stripTags(html.slice(tagEnd + 1, close < 0 ? tagEnd + 1 : close)));
      if (close >= 0) tokenRe.lastIndex = close;
      continue;
    }

    if (kind === '</dl') {
      folders.pop();
      tokenRe.lastIndex = tagEnd;
      continue;
    }

    if (kind === '<a') {
      const close = lower.indexOf('</a', tagEnd);
      const inner = close < 0 ? '' : html.slice(tagEnd + 1, close);
      const url = attr(tag, 'href')?.trim();
      if (url && /^(https?|ftp|file):/i.test(url)) {
        last = {
          url,
          title: stripTags(inner) || url,
          description: '',
          folderPath: folders.join('/'),
          addedAt: toIso(attr(tag, 'ADD_DATE')),
          tags: (attr(tag, 'TAGS') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        };
        out.push(last);
      } else {
        last = null;
      }
      if (close >= 0) tokenRe.lastIndex = close;
      continue;
    }

    // <DD> runs until the next structural tag rather than a closing tag.
    if (kind === '<dd' && last) {
      const rest = html.slice(tagEnd + 1);
      const stop = rest.search(/<(dt|dd|dl|\/dl)\b/i);
      last.description = stripTags(stop < 0 ? rest : rest.slice(0, stop));
      tokenRe.lastIndex = tagEnd;
    }
  }

  return out;
}

/** Serialize back to Netscape HTML, reconstructing the original folder tree. */
export function toNetscapeHtml(items: RawBookmark[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  interface Node {
    folders: Map<string, Node>;
    items: RawBookmark[];
  }
  const root: Node = { folders: new Map(), items: [] };

  for (const it of items) {
    let node = root;
    for (const p of (it.folderPath || '').split('/').filter(Boolean)) {
      if (!node.folders.has(p)) node.folders.set(p, { folders: new Map(), items: [] });
      node = node.folders.get(p)!;
    }
    node.items.push(it);
  }

  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  const render = (node: Node, depth: number) => {
    const pad = '    '.repeat(depth);
    for (const [name, child] of node.folders) {
      lines.push(`${pad}<DT><H3>${esc(name)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      render(child, depth + 1);
      lines.push(`${pad}</DL><p>`);
    }
    for (const it of node.items) {
      const add = it.addedAt ? ` ADD_DATE="${Math.floor(new Date(it.addedAt).getTime() / 1000)}"` : '';
      const tags = it.tags.length ? ` TAGS="${esc(it.tags.join(','))}"` : '';
      lines.push(`${pad}<DT><A HREF="${esc(it.url)}"${add}${tags}>${esc(it.title)}</A>`);
      if (it.description) lines.push(`${pad}<DD>${esc(it.description)}`);
    }
  };

  render(root, 1);
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}
