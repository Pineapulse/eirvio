import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, extname} from 'node:path';
import {createTaskBoard} from './domain.mjs';

export function createDemoServer() {
  const {host} = createTaskBoard();
  const root = dirname(fileURLToPath(import.meta.url));
  const sdk = resolve(root, '../../packages/sdk/src');
  const auto = resolve(root, '../auto-interface');
  const allowedMethods = new Set(['observe', 'catalog', 'submit', 'getOutcome', 'control']);
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) {res.writeHead(403).end(); return;}
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.url === '/api/rpc' && req.method === 'POST') {
      if (!hosts.map(host => `http://${host}`).includes(req.headers.origin) || !req.headers['content-type']?.startsWith('application/json')) {
        res.writeHead(403).end(); return;
      }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {size += chunk.length; if (size > 65536) throw Object.assign(new Error(), {code: 'RESOURCE_LIMIT'}); chunks.push(chunk);}
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!allowedMethods.has(request.method) || !Array.isArray(request.args) || request.args.length > 1) throw Object.assign(new Error(), {code: 'INVALID_REQUEST'});
        const expected = ['observe', 'catalog'].includes(request.method) ? 0 : 1;
        if (request.args.length !== expected) throw Object.assign(new Error(), {code: 'INVALID_REQUEST'});
        const result = host[request.method](...request.args);
        // Deliberate local demo fault: state commits, but the client receives no acknowledgement.
        if (request.loseReply === true && request.method === 'submit') {res.destroy(); return;}
        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(result));
      } catch (error) {
        const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'INVALID_REQUEST';
        res.writeHead(400, {'Content-Type': 'application/json'}).end(JSON.stringify({error: code}));
      }
      return;
    }
    if (req.method !== 'GET') {res.writeHead(405).end(); return;}
    const url = req.url.split('?')[0];
    const files = {'/': resolve(auto, 'index.html'), '/task-board':resolve(root,'index.html'), '/vendor/babylon.mjs':resolve(root,'../../reports/babylon.mjs'), '/app.mjs': resolve(root, 'app.mjs'), '/styles.css': resolve(root, 'styles.css')};
    for(const name of ['app.mjs','game.mjs','styles.css','tokens.css'])files['/auto/'+name]=resolve(auto,name);
    // SDK modules only; never serve core stores, snapshots, local files or a directory listing.
    if (/^\/sdk\/[a-z][a-z-]*\.mjs$/.test(url)) files[url] = resolve(sdk, url.split('/').at(-1));
    try {
      if (!files[url] || url === '/sdk/host.mjs') throw new Error('Not public');
      const body = await readFile(files[url]);
      res.writeHead(200, {'Content-Type': {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript'}[extname(files[url])]}).end(body);
    } catch {res.writeHead(404).end('Not found');}
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDemoServer();
  const port = Number(process.env.PORT || 8810);
  server.listen(port, '127.0.0.1', () => console.log(`Agent interface workbench: http://127.0.0.1:${server.address().port}\nLocal, in-memory example. No model or analytics services.`));
  const stop = () => server.close();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
