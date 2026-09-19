import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/progress-data.js', ['progress-data.js', 'text/javascript; charset=utf-8']],
  ['/progress-model.js', ['progress-model.js', 'text/javascript; charset=utf-8']],
]);

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/healthz') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  const file = FILES.get(pathname);
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404, headers);
    response.end();
    return;
  }
  try {
    const content = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, { ...headers, 'Content-Type': file[1] });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500, headers);
    response.end();
  }
}).listen(port, '0.0.0.0');
