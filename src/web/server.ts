/**
 * Local HTTP host for the GUI.
 *
 * Thin by design: it serves static assets and translates HTTP into the
 * transport-agnostic API in ../api.ts. A browser extension or desktop shell
 * can skip this file entirely and call `handle()` directly.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DB } from '../db.ts';
import { handle, streamCheck, type ApiRequest } from '../api.ts';
import type { PolitenessConfig } from '../core/polite.ts';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Uploaded bookmark files can be large; allow room but not unbounded. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Upload too large (limit 64 MB).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(db: DB): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const json = (status: number, body: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      // ---- streamed link check (Server-Sent Events) ----
      if (path === '/api/check/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emit = (event: string, data: any) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let cancelled = false;
        req.on('close', () => {
          cancelled = true;
        });

        try {
          const politeness: Partial<PolitenessConfig> =
            url.searchParams.get('fast') === '1'
              ? { minDelayMs: 300, maxDelayMs: 900, globalConcurrency: 6 }
              : {};
          if (url.searchParams.get('insecureTLS') === '1') politeness.insecureTLS = true;

          await streamCheck(
            db,
            {
              limit: Number(url.searchParams.get('limit') ?? 200),
              includePrivate: url.searchParams.get('private') === '1',
              recheckAfterDays: Number(url.searchParams.get('recheckDays') ?? 30),
              politeness,
              shouldStop: () => cancelled,
            },
            emit,
          );
        } catch (e: any) {
          emit('error', { message: e.message });
        }
        return res.end();
      }

      // ---- JSON API ----
      if (path.startsWith('/api/')) {
        let body: any = null;
        if (req.method === 'POST') {
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            return json(400, { error: 'Malformed JSON body.' });
          }
        }

        const apiReq: ApiRequest = {
          method: req.method ?? 'GET',
          path,
          query: url.searchParams,
          body,
        };
        const out = await handle(db, apiReq);

        if (out.download) {
          res.writeHead(out.status, {
            'Content-Type': out.download.contentType,
            'Content-Disposition': `attachment; filename="${out.download.filename}"`,
          });
          return res.end(out.download.text);
        }
        return json(out.status, out.body);
      }

      // ---- static assets ----
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const full = join(PUBLIC_DIR, normalizePath(rel));
      if (!full.startsWith(PUBLIC_DIR)) {
        return json(403, { error: 'Forbidden' });
      }

      try {
        const data = await readFile(full);
        res.writeHead(200, {
          'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        return res.end(data);
      } catch {
        // Unknown paths fall back to the app shell so client routing works.
        const shell = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(shell);
      }
    } catch (e: any) {
      json(500, { error: e?.message ?? 'Internal error' });
    }
  });
}

export function startServer(db: DB, port = 7777): Promise<number> {
  const server = createApp(db);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: this is a local tool, not a network service.
    server.listen(port, '127.0.0.1', () => resolve((server.address() as any).port));
  });
}
