import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const apiOrigin = new URL(process.env.CONVO_API_ORIGIN || 'http://127.0.0.1:3000');
const proxyRequest = apiOrigin.protocol === 'https:' ? httpsRequest : httpRequest;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function proxyHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHop.has(name.toLowerCase())),
  );
}

function proxyApi(request, response) {
  const upstreamHeaders = proxyHeaders(request.headers);
  upstreamHeaders.host = apiOrigin.host;
  upstreamHeaders['x-forwarded-host'] = request.headers.host || '';
  upstreamHeaders['x-forwarded-proto'] = request.headers['x-forwarded-proto'] || 'http';
  // Append the address *we* observed, which is the only entry in this header
  // anybody downstream has a reason to believe. Everything already in it was
  // written by a hop further out — the Railway edge in production, an attacker's
  // own request anywhere else — and the API decides how many of those to trust
  // by counting from the right (CONVO_TRUSTED_PROXY_HOPS; see
  // apps/api/src/client-address.ts). Passing the header through untouched, as
  // this did before, left the API with no trustworthy entry at all.
  const observed = request.socket.remoteAddress || '';
  const existing = request.headers['x-forwarded-for'];
  const chain = Array.isArray(existing) ? existing.join(', ') : existing;
  upstreamHeaders['x-forwarded-for'] = chain ? `${chain}, ${observed}` : observed;

  const upstream = proxyRequest(
    new URL(request.url || '/api', apiOrigin),
    { method: request.method, headers: upstreamHeaders },
    (incoming) => {
      response.writeHead(incoming.statusCode || 502, proxyHeaders(incoming.headers));
      incoming.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
    }
    response.end(JSON.stringify({ error: { code: 'api_unavailable', message: 'The API is unavailable.' } }));
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

/**
 * The response headers every document carries.
 *
 * Each one is here because of a specific attack, and each is set to the
 * tightest value this application actually works under — a policy that breaks
 * the product gets removed by the next person in a hurry, which leaves nothing.
 *
 * - **CSP.** `'self'` everywhere, plus one `'unsafe-inline'` for scripts that is
 *   not optional: `index.html` carries an inline theme script that must run
 *   before first paint to avoid a light flash, and a nonce cannot be minted by a
 *   static file server streaming a fixed file. Styles are inline for the same
 *   reason the design tokens are. `connect-src 'self'` keeps the SPA talking
 *   only to its own origin, which is where the API is. `frame-ancestors 'none'`
 *   is the clickjacking control and supersedes X-Frame-Options, which is kept
 *   only for browsers that predate it. `base-uri` and `form-action` close the
 *   two redirect-style bypasses that CSP is otherwise silent about.
 * - **HSTS** only when the request arrived over TLS. Sending it over plain HTTP
 *   would pin a local development host to a scheme it does not serve.
 * - **Permissions-Policy** denies the device APIs this product never asks for,
 *   so a future dependency cannot quietly start asking.
 */
function securityHeaders(request) {
  const https = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function serveFile(pathname, request, response) {
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  let file = join(root, relative || 'index.html');
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=86400',
    ...securityHeaders(request),
  });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  if (pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end('{"status":"ok"}');
    return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxyApi(request, response);
    return;
  }
  serveFile(pathname, request, response);
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`CONVO web listening on ${port}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
