// app.ts — the forge's HTTP server: routing, auth, body handling, JSON replies.
//
// Routes:
//   GET  /healthz                      200 {"ok":true} (no auth; the env's boot check)
//   /<owner>/<repo>.git/info/refs      git smart-HTTP advertisements (no auth)
//   /<owner>/<repo>.git/git-upload-pack
//   /<owner>/<repo>.git/git-receive-pack
//   /api/v3/...                        GitHub REST v3 (Bearer token required)
//   /api/graphql, /mcp                M2 surfaces; M1 answers a JSON 404
//   anything else                      JSON 404 {"message":"Not Found"}
//
// Every reply carries a non-empty X-GitHub-Request-Id (a deterministic per-process counter,
// so two runs that receive the same requests answer the same ids).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitReply } from './gitwire.ts';
import { handleRest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, requestId: string): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo, read:org' });
  res.end();
}

function sendGit(res: ServerResponse, reply: GitReply, requestId: string): void {
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    'x-github-request-id': requestId,
  });
  res.end(reply.body);
}

function sendText(res: ServerResponse, status: number, text: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

/** Read the whole request body (capped); rejects when it is too large. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function splitSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${String(requestCounter).padStart(8, '0')}`;
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const pathname = url.pathname;

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
        if (gitMatch) {
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          const suffix = gitMatch[3] ?? '';
          const gitProtocol = req.headers['git-protocol'];
          if (method === 'GET' && suffix === '/info/refs') {
            const service = url.searchParams.get('service') ?? '';
            sendGit(res, handleInfoRefs(store, owner, repoName, service, gitProtocol), requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            const body = await readBody(req);
            sendGit(res, handleUploadPack(store, owner, repoName, body, gitProtocol), requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            const body = await readBody(req);
            sendGit(res, handleReceivePack(store, owner, repoName, body), requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // REST v3 and the M2 surfaces: a Bearer token is required.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/') || pathname === '/api/graphql' || pathname === '/mcp') {
          const authorization = req.headers.authorization ?? '';
          const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
          if (token === '' || (store.token !== null && token !== store.token)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          if (pathname === '/api/graphql' || pathname === '/mcp') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const segments = splitSegments(pathname.slice('/api/v3'.length));
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
                return;
              }
            }
          }
          const baseUrl = `http://${req.headers.host ?? 'entry'}${pathname}`;
          const reply = handleRest(store, method, segments, url.searchParams, body, baseUrl);
          if (reply.status === 204) {
            sendEmpty(res, 204, requestId);
            return;
          }
          sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendText(res, 500, `internal error: ${(err as Error).message}`, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
