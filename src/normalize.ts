/**
 * URL normalization — the foundation of deduplication.
 *
 * Rules (settled in design):
 *   lowercase scheme/host, drop default ports, strip tracker params,
 *   strip fragments except SPA #! routes, drop trailing slash.
 */

const TRACKER_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^ref_src$/i,
  /^ref_url$/i,
  /^spm$/i,
  /^_hs(enc|mi)$/i,
  /^vero_(conv|id)$/i,
  /^yclid$/i,
  /^s_cid$/i,
  /^si$/i,
  /^__s$/i,
];

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ftp:': '21',
};

export function isTrackerParam(name: string): boolean {
  return TRACKER_PARAMS.some((re) => re.test(name));
}

/** Parse a URL, tolerating scheme-less input like "example.com/x". */
export function parseUrl(raw: string): URL | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    if (/^[\w.-]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(trimmed)) {
      try {
        return new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Produce the canonical form used for duplicate detection.
 * Returns the original trimmed string if it cannot be parsed, so that
 * unparseable entries still group with their exact twins.
 */
export function normalizeUrl(raw: string): string {
  const u = parseUrl(raw);
  if (!u) return (raw ?? '').trim();

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');

  if (u.port && DEFAULT_PORTS[u.protocol] === u.port) u.port = '';

  // Strip tracker params, then sort the remainder for stable comparison.
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!isTrackerParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Fragments are noise, except SPA hashbang routes which are real addresses.
  if (!u.hash.startsWith('#!')) u.hash = '';

  let out = u.toString();

  // Drop a trailing slash on the path when it carries no meaning.
  if (!u.search && !u.hash && u.pathname !== '/' && out.endsWith('/')) {
    out = out.slice(0, -1);
  } else if (u.pathname === '/' && !u.search && !u.hash) {
    out = out.slice(0, -1);
  }

  return out;
}

/** Host+path only — the key used to flag near-duplicates that differ by query. */
export function nearDuplicateKey(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  const path = u.pathname.replace(/\/$/, '');
  return `${u.hostname.toLowerCase()}${path}`;
}

export function hostOf(raw: string): string | null {
  const u = parseUrl(raw);
  return u ? u.hostname.toLowerCase() : null;
}

/** Registrable-ish domain, good enough for per-domain rate limiting and tagging. */
export function registrableDomain(raw: string): string | null {
  const host = hostOf(raw);
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevelTlds = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'co.za', 'org.uk', 'ac.uk', 'com.cn']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}
