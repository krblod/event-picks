// Local static server for development: node tools/serve.js [port]  ->  http://localhost:8080
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SERVED = /^\/(index\.html|css\/[\w.-]+\.css|js\/[\w.-]+\.js|data\/[\w.-]+\.json|icons\/[\w.-]+|manifest\.webmanifest|sw\.js)$/;

function start(port) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/index.html';
    if (!SERVED.test(p)) { res.writeHead(404); return res.end('Not found'); }
    const file = path.join(ROOT, p);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8080;
  start(port).then(() => console.log('Event Picks on http://localhost:' + port));
}
module.exports = { start };
