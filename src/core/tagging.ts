/**
 * Deterministic auto-tagging. No LLM, no network calls — rules only.
 * Suggestions are reviewable in bulk before they are applied.
 */

import { registrableDomain } from './normalize.ts';
import type { RawBookmark } from './importers/netscape.ts';

export interface KeywordRule {
  /** Case-insensitive substring or /regex/ matched against title + url. */
  match: string;
  tag: string;
}

export function slugTag(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-/.:]/g, '')
    .toLowerCase();
}

/** Browser folders become tags, while folder_path is kept intact for export. */
export function folderTags(folderPath: string): string[] {
  const parts = (folderPath || '').split('/').filter(Boolean);
  if (!parts.length) return [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(`folder:${parts.slice(0, i + 1).map(slugTag).join('/')}`);
  }
  return out;
}

export function autoTags(bm: RawBookmark, source: string, rules: KeywordRule[] = []): string[] {
  const tags = new Set<string>();

  const domain = registrableDomain(bm.url);
  if (domain) tags.add(`site:${domain}`);

  if (source) tags.add(`src:${slugTag(source)}`);

  for (const t of folderTags(bm.folderPath)) tags.add(t);
  for (const t of bm.tags) if (t) tags.add(slugTag(t));

  const haystack = `${bm.title}\n${bm.url}\n${bm.description}`.toLowerCase();
  for (const rule of rules) {
    const m = rule.match.match(/^\/(.*)\/([gimsu]*)$/);
    const hit = m ? new RegExp(m[1], m[2] || 'i').test(haystack) : haystack.includes(rule.match.toLowerCase());
    if (hit) tags.add(slugTag(rule.tag));
  }

  return [...tags];
}
