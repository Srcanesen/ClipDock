// Local preview server for the ClipDock panel. Serves the SAME production build
// (dist/) on http://127.0.0.1 — the only difference is a preview.js <script>
// injected ahead of renderer.js, which supplies a fake clipdockAPI selected by
// the ?preview= query. No real Resolve needed.
//
// Run: npm run preview   (builds first, then starts this server)
//      open http://127.0.0.1:8790/?preview=ready
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpilePreviewAdapter } from './lib/preview-adapter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`No build found at ${dist}. Run "npm run build" first.`);
  process.exit(1);
}

const previewAdapter = transpilePreviewAdapter(root);

/** Resolve a request path to a file inside dist/, or null when it escapes it. */
function resolveInsideDist(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null; // malformed percent-encoding
  }
  const rel = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const target = path.normalize(path.join(dist, rel));
  if (target !== dist && !target.startsWith(dist + path.sep)) return null; // path traversal
  if (existsSync(target)) {
    const realDist = realpathSync(dist);
    const realTarget = realpathSync(target);
    if (realTarget !== realDist && !realTarget.startsWith(realDist + path.sep)) return null;
  }
  return target;
}

const server = createServer((req, res) => {
  try {
  const raw = req.url ?? '/';
  const pathPart = raw.split('?')[0];
  const target = resolveInsideDist(pathPart === '/' ? '/index.html' : pathPart);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (pathPart === '/' || pathPart === '/index.html') {
    const html = readFileSync(target, 'utf8');
    const rendererScript = /<script\b[^>]*\bsrc=["']\.\/renderer\.js["'][^>]*><\/script>/i;
    const injected = html.replace(
      rendererScript,
      '<script type="text/javascript" src="preview.js"></script>$&',
    );
    if (injected === html) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Preview injection point not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(injected);
    return;
  }

  if (pathPart === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (pathPart === '/preview.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(previewAdapter);
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const body = readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(body);
  } catch (error) {
    res.writeHead(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 503 : 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Preview artifact unavailable; rebuild and retry');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ClipDock preview: http://${HOST}:${PORT}/?preview=ready`);
  console.log('Fixtures: ready | no-project | no-timeline | bridge-error | loading | empty | error | queue | audio | pexels-photo | pexels-video | pixabay | pinterest | pinterest-search | duplicate | missing-file | download-failed');
  console.log('Press Ctrl+C to stop.');
});
