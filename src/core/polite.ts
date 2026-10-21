/**
 * Polite fetch layer.
 *
 * Shared by the link checker and (later) the article extractor, so the
 * politeness rules are enforced in exactly one place.
 *
 * Default posture is deliberately slow: a bookmark archive has no deadline,
 * and the failure mode of going fast is getting your IP blocked.
 */

import { registrableDomain } from './normalize.ts';

export interface PolitenessConfig {
  userAgent: string;
  minDelayMs: number;
  maxDelayMs: number;
  domainConcurrency: number;
  globalConcurrency: number;
  timeoutMs: number;
  maxRetries: number;
  respectRobots: boolean;
  /**
   * Skip certificate verification. Off by default — only for users who
   * explicitly opt in, e.g. behind a corporate TLS-inspecting proxy whose
   * root CA isn't in Node's trust store. Weakens the integrity of this run.
   */
  insecureTLS: boolean;
}

export const DEFAULT_POLITENESS: PolitenessConfig = {
  // A real browser UA: we are a user's own bookmark checker, not a crawler.
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  minDelayMs: 5_000,
  maxDelayMs: 10_000,
  domainConcurrency: 1,
  globalConcurrency: 4,
  timeoutMs: 20_000,
  maxRetries: 2,
  respectRobots: true,
  insecureTLS: false,
};

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Node's global `fetch` consults `NODE_TLS_REJECT_UNAUTHORIZED` at connect
 * time, so toggling it around a call scopes the relaxed verification to
 * that call only (and restores the prior value, even if unset).
 */
async function withTLSMode<T>(insecure: boolean, fn: () => Promise<T>): Promise<T> {
  if (!insecure) return fn();
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}

function jitter(cfg: PolitenessConfig): number {
  return cfg.minDelayMs + Math.random() * Math.max(0, cfg.maxDelayMs - cfg.minDelayMs);
}

// ---------------------------------------------------------------- robots.txt

interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

function parseRobots(text: string, ua: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };
  let active = false;
  let sawSpecific = false;

  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const [rawKey, ...rest] = clean.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      const agent = value.toLowerCase();
      if (agent === '*') {
        active = !sawSpecific;
      } else if (ua.toLowerCase().includes(agent)) {
        active = true;
        sawSpecific = true;
        rules.disallow = [];
        rules.allow = [];
      } else {
        active = false;
      }
      continue;
    }
    if (!active) continue;

    if (key === 'disallow' && value) rules.disallow.push(value);
    else if (key === 'allow' && value) rules.allow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) rules.crawlDelayMs = n * 1000;
    }
  }
  return rules;
}

function robotsAllows(rules: RobotsRules, path: string): boolean {
  const match = (pattern: string): number => {
    const re = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\$$/, '$'),
    );
    return re.test(path) ? pattern.length : -1;
  };
  const bestAllow = Math.max(-1, ...rules.allow.map(match));
  const bestDisallow = Math.max(-1, ...rules.disallow.map(match));
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

// ------------------------------------------------------------ domain gating

interface DomainState {
  nextAllowedAt: number;
  active: number;
  robots: RobotsRules | null | undefined;
}

export class PoliteFetcher {
  private domains = new Map<string, DomainState>();
  private globalActive = 0;
  readonly cfg: PolitenessConfig;

  constructor(cfg: Partial<PolitenessConfig> = {}) {
    this.cfg = { ...DEFAULT_POLITENESS, ...cfg };
  }

  private state(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = { nextAllowedAt: 0, active: 0, robots: undefined };
      this.domains.set(domain, s);
    }
    return s;
  }

  private async acquire(domain: string): Promise<void> {
    const s = this.state(domain);
    for (;;) {
      const now = Date.now();
      if (this.globalActive < this.cfg.globalConcurrency && s.active < this.cfg.domainConcurrency && now >= s.nextAllowedAt) {
        this.globalActive++;
        s.active++;
        return;
      }
      await sleep(Math.min(1000, Math.max(50, s.nextAllowedAt - now)));
    }
  }

  private release(domain: string, extraDelayMs = 0): void {
    const s = this.state(domain);
    s.active = Math.max(0, s.active - 1);
    this.globalActive = Math.max(0, this.globalActive - 1);
    const base = jitter(this.cfg);
    const crawl = s.robots?.crawlDelayMs ?? 0;
    s.nextAllowedAt = Date.now() + Math.max(base, crawl) + extraDelayMs;
  }

  private async loadRobots(origin: string, domain: string): Promise<RobotsRules | null> {
    const s = this.state(domain);
    if (s.robots !== undefined) return s.robots;
    try {
      const res = await withTLSMode(this.cfg.insecureTLS, async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
        try {
          return await fetch(`${origin}/robots.txt`, {
            headers: { 'User-Agent': this.cfg.userAgent, ...BROWSER_HEADERS },
            signal: ctrl.signal,
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timer);
        }
      });
      s.robots = res.ok ? parseRobots(await res.text(), this.cfg.userAgent) : null;
    } catch {
      s.robots = null; // no robots.txt reachable: proceed, politely
    }
    return s.robots;
  }

  /**
   * Fetch one URL under all politeness rules.
   * Never throws on network failure — returns a verdict instead.
   */
  async fetch(
    rawUrl: string,
    opts: { method?: 'HEAD' | 'GET' } = {},
  ): Promise<{
    ok: boolean;
    status: number | null;
    finalUrl: string | null;
    verdict: 'alive' | 'dead' | 'unknown' | 'skipped';
    note: string;
    body?: Response;
  }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, status: null, finalUrl: null, verdict: 'dead', note: 'unparseable-url' };
    }

    const domain = registrableDomain(rawUrl) ?? url.hostname;
    await this.acquire(domain);
    let extraDelay = 0;

    try {
      if (this.cfg.respectRobots) {
        const rules = await this.loadRobots(url.origin, domain);
        if (rules && !robotsAllows(rules, url.pathname)) {
          return { ok: false, status: null, finalUrl: null, verdict: 'skipped', note: 'robots-disallow' };
        }
      }

      let method: 'HEAD' | 'GET' = opts.method ?? 'HEAD';

      for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
        if (attempt > 0) await sleep(1000 * 2 ** attempt + Math.random() * 500);

        try {
          const res = await withTLSMode(this.cfg.insecureTLS, async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
            try {
              return await fetch(url.toString(), {
                method,
                headers: { 'User-Agent': this.cfg.userAgent, ...BROWSER_HEADERS },
                redirect: 'follow',
                signal: ctrl.signal,
              });
            } finally {
              clearTimeout(timer);
            }
          });

          // Many servers reject HEAD; that is not a dead link.
          if ((res.status === 405 || res.status === 501) && method === 'HEAD') {
            method = 'GET';
            attempt--;
            continue;
          }

          if (res.status === 429 || res.status === 503) {
            const ra = Number(res.headers.get('retry-after'));
            extraDelay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 300_000) : 60_000;
            if (attempt < this.cfg.maxRetries) continue;
            return { ok: false, status: res.status, finalUrl: res.url, verdict: 'unknown', note: 'rate-limited' };
          }

          // Blocked, not broken. Never call this dead.
          if (res.status === 403 || res.status === 401) {
            const server = (res.headers.get('server') ?? '').toLowerCase();
            const note = server.includes('cloudflare') ? 'cloudflare-challenge' : 'access-denied';
            return { ok: false, status: res.status, finalUrl: res.url, verdict: 'unknown', note };
          }

          if (res.status >= 200 && res.status < 400) {
            return { ok: true, status: res.status, finalUrl: res.url, verdict: 'alive', note: '', body: res };
          }

          if (res.status === 404 || res.status === 410) {
            return { ok: false, status: res.status, finalUrl: res.url, verdict: 'dead', note: `http-${res.status}` };
          }

          if (res.status >= 500) {
            if (attempt < this.cfg.maxRetries) continue;
            return { ok: false, status: res.status, finalUrl: res.url, verdict: 'unknown', note: 'server-error' };
          }

          return { ok: false, status: res.status, finalUrl: res.url, verdict: 'unknown', note: `http-${res.status}` };
        } catch (err: any) {
          const msg = String(err?.cause?.code ?? err?.name ?? err?.message ?? 'error');
          const dns = /ENOTFOUND|EAI_AGAIN/i.test(msg);
          const tls = /CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED/i.test(msg);
          if (attempt < this.cfg.maxRetries && !dns && !tls) continue;
          return {
            ok: false,
            status: null,
            finalUrl: null,
            // A TLS failure usually means an intercepting proxy, not a dead link.
            verdict: dns ? 'dead' : 'unknown',
            note: dns ? 'dns-failure' : tls ? `tls-error:${msg}` : msg,
          };
        }
      }

      return { ok: false, status: null, finalUrl: null, verdict: 'unknown', note: 'retries-exhausted' };
    } finally {
      this.release(domain, extraDelay);
    }
  }
}

export function waybackUrl(url: string): string {
  return `https://web.archive.org/web/*/${url}`;
}
