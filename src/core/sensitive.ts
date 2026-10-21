/**
 * Sensitive URL detection.
 *
 * "Sensitive" means: must not leak, must not be fetched, must not appear
 * in exports or logs unless explicitly asked for.
 */

import { parseUrl, hostOf } from './normalize.ts';

const SECRET_PARAM = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|auth|session|sig|signature|credential|private[-_]?key)/i;

/** Long opaque strings in a query value look like credentials even if the key is bland. */
const OPAQUE_VALUE = /^[A-Za-z0-9_\-]{32,}$/;

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.home$/i,
];

export interface SensitivityVerdict {
  sensitive: boolean;
  reasons: string[];
}

export function assessUrl(raw: string): SensitivityVerdict {
  const reasons: string[] = [];
  const u = parseUrl(raw);
  if (!u) return { sensitive: false, reasons };

  if (u.username || u.password) reasons.push('userinfo-in-url');

  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.some((re) => re.test(host))) reasons.push('private-host');

  for (const [k, v] of u.searchParams) {
    if (SECRET_PARAM.test(k)) {
      reasons.push(`secret-param:${k}`);
    } else if (OPAQUE_VALUE.test(v)) {
      reasons.push(`opaque-value:${k}`);
    }
  }

  if (/[?&#](token|key)=/i.test(raw) && reasons.length === 0) reasons.push('secret-param');

  return { sensitive: reasons.length > 0, reasons };
}

/**
 * Redact a URL for safe display in logs and exports.
 * Keeps the shape recognizable; destroys the secret.
 */
export function redactUrl(raw: string): string {
  const u = parseUrl(raw);
  if (!u) return '[unparseable-url]';

  if (u.username || u.password) {
    u.username = '***';
    u.password = '';
  }

  const toRedact: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (SECRET_PARAM.test(k) || OPAQUE_VALUE.test(v)) toRedact.push(k);
  }
  for (const k of toRedact) u.searchParams.set(k, '[REDACTED]');

  return u.toString();
}

/** Domains the user has marked sensitive wholesale. */
export function hostMatchesList(url: string, domains: Set<string>): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (domains.has(host)) return true;
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (domains.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}
