import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 3000);
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok:true, service:'cnc-trainer-pro', version:'0.2.0' }));
  }
  try {
    let requested = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let target = path.join(dist, requested === '/' ? 'index.html' : requested);
    try { if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html'); } catch { target = path.join(dist, 'index.html'); }
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' }); res.end('Not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`CNC Trainer PRO listening on ${port}`));
