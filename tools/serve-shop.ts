/**
 * Serves test-shop/ over http on a fixed port (default 5050), so the content
 * script (http/https only) runs on it. Clean URLs work too (/product serves
 * product.html). Fails loudly if the port is busy instead of quietly picking
 * another one. No dependencies.
 *
 * Run with: npm run shop   [-- --port 5050]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SHOP = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-shop');
export const SHOP_PORT = 5050;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Starts the server; port 0 picks a free port. Resolves once listening. */
export function serveShop(port = SHOP_PORT): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(SHOP, path));
    if (file !== SHOP && !file.startsWith(SHOP + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      // Clean URLs: /product serves product.html.
      if (!extname(file) && !existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      statSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not found: ${path}`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // No host: listens on :: dual-stack, so localhost works whether it resolves to ::1 or 127.0.0.1.
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: String(SHOP_PORT) } } });
  try {
    const { port } = await serveShop(Number(values.port));
    console.log(`Test shop: http://localhost:${port}/product.html  (also /index.html, /cart.html, /checkout.html)`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `Port ${values.port} is already in use. Stop whatever is using it or run: npm run shop -- --port <other>`
        : String(err),
    );
    process.exit(1);
  }
}
