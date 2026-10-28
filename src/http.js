// Mini-framework HTTP sem dependências: rotas com parâmetros, JSON e arquivos estáticos.
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Resposta que não é JSON (CSV, texto puro...).
export class Reply {
  constructor(body, { status = 200, headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.headers = headers;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, handler, options = {}) {
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp(`^${pattern}/?$`), keys, handler, options });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Conteúdo muito grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

export function serveStatic(root, req, res, pathname) {
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) && file !== root) return false;
  let st;
  try { st = statSync(file); } catch { st = null; }
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    try { st = statSync(file); } catch { st = null; }
  }
  if (!st?.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
