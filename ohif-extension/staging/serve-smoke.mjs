import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

if (!process.argv[2]) throw new Error('Pass the absolute path to the synthetic OHIF dist directory.');
const dist = resolve(process.argv[2]);
const routes = new Set(['/', '/localbasic', '/viewer', '/viewer/dicomlocal']);
const types = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.png': 'image/png', '.woff2': 'font/woff2',
};
await stat(resolve(dist, 'index.html'));

createServer(async (request, response) => {
  if (!['HEAD', 'GET'].includes(request.method)) return response.writeHead(405).end();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  } catch {
    return response.writeHead(400).end();
  }
  const file = resolve(dist, '.' + (routes.has(pathname) ? '/index.html' : pathname));
  const details = file.startsWith(dist + sep) && await stat(file).catch(() => null);
  if (!details?.isFile()) return response.writeHead(404).end();
  response.writeHead(200, {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-store',
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Content-Length': details.size,
  });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
}).listen(38611, '127.0.0.1', () => console.log('Synthetic OHIF available at http://127.0.0.1:38611/localbasic'));
