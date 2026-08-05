const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control':'no-cache'});
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/api/health') {
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
    return res.end(JSON.stringify({ok:true, app:'CNC Trainer PRO', version:'0.1.0'}));
  }
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.normalize(path.join(publicDir, requested));
  if (!resolved.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) return sendFile(res, resolved);
    sendFile(res, path.join(publicDir, 'index.html'));
  });
});

server.listen(port, '0.0.0.0', () => console.log(`CNC Trainer PRO listening on port ${port}`));
