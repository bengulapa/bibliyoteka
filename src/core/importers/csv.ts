/**
 * CSV importer with a column mapper — covers Pocket, Instapaper,
 * Raindrop, Omnivore and anything else that exports a table.
 */

import type { RawBookmark } from './netscape.ts';

/** RFC 4180 parser: handles quoted fields, embedded commas, newlines, "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ColumnMap {
  url?: string;
  title?: string;
  description?: string;
  tags?: string;
  added?: string;
  folder?: string;
}

const ALIASES: Record<keyof ColumnMap, string[]> = {
  url: ['url', 'uri', 'link', 'href', 'address'],
  title: ['title', 'name', 'headline'],
  description: ['description', 'excerpt', 'note', 'notes', 'summary'],
  tags: ['tags', 'labels', 'folder_tags', 'keywords'],
  added: ['added', 'time_added', 'date', 'created', 'created_at', 'saved_at', 'date_added'],
  folder: ['folder', 'folders', 'collection', 'path'],
};

/** Guess the column mapping from a header row; explicit overrides always win. */
export function inferColumnMap(header: string[], overrides: ColumnMap = {}): ColumnMap {
  const norm = header.map((h) => h.trim().toLowerCase());
  const map: ColumnMap = {};
  for (const key of Object.keys(ALIASES) as (keyof ColumnMap)[]) {
    if (overrides[key]) {
      map[key] = overrides[key];
      continue;
    }
    const found = ALIASES[key].find((a) => norm.includes(a));
    if (found) map[key] = header[norm.indexOf(found)];
  }
  return map;
}

function parseDate(v: string): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (/^\d{9,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    const d = new Date(trimmed.length > 10 ? n : n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseCsvBookmarks(text: string, overrides: ColumnMap = {}): RawBookmark[] {
  const rows = parseCsv(text);
  if (rows.length < 1) return [];

  const header = rows[0].map((h) => h.trim());
  const map = inferColumnMap(header, overrides);
  if (!map.url) throw new Error(`CSV has no recognizable URL column. Headers: ${header.join(', ')}`);

  const idx = (name?: string) => (name ? header.indexOf(name) : -1);
  const iUrl = idx(map.url);
  const iTitle = idx(map.title);
  const iDesc = idx(map.description);
  const iTags = idx(map.tags);
  const iAdded = idx(map.added);
  const iFolder = idx(map.folder);

  const out: RawBookmark[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const url = (row[iUrl] ?? '').trim();
    if (!url) continue;

    out.push({
      url,
      title: (iTitle >= 0 ? row[iTitle] : '')?.trim() || url,
      description: (iDesc >= 0 ? row[iDesc] : '')?.trim() ?? '',
      folderPath: (iFolder >= 0 ? row[iFolder] : '')?.trim().replace(/^\/+|\/+$/g, '') ?? '',
      addedAt: iAdded >= 0 ? parseDate(row[iAdded] ?? '') : null,
      tags: (iTags >= 0 ? row[iTags] : '')
        ?.split(/[,|]/)
        .map((t) => t.trim())
        .filter(Boolean) ?? [],
    });
  }
  return out;
}
