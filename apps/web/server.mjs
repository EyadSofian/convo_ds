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

function serveFile(pathname, response) {
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  let file = join(root, relative || 'index.html');
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
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
  serveFile(pathname, response);
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`CONVO web listening on ${port}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
