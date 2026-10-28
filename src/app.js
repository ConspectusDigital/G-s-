import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpError, Reply, Router, parseCookies, readBody, sendJSON, serveStatic } from './http.js';
import { getSettings, openDatabase } from './db.js';
import { userFromToken } from './auth.js';
import { createProvider } from './whatsapp/index.js';
import { createQueue, startScheduler } from './services/autosend.js';
import { registerAuth } from './routes/auth.js';
import { registerCustomers } from './routes/customers.js';
import { registerOrders } from './routes/orders.js';
import { registerReminders } from './routes/reminders.js';
import { registerChat } from './routes/chat.js';
import { registerAdmin } from './routes/admin.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ dbPath, scheduler = true } = {}) {
  const db = openDatabase(dbPath);
  const clients = new Set();

  let settings;
  let provider;
  const ctx = {
    db,
    settings: () => settings,
    provider: () => provider,
    reloadSettings() {
      settings = getSettings(db);
      process.env.TZ = settings.timezone || 'America/Sao_Paulo';
      provider = createProvider(settings);
    },
    // Eventos em tempo real para as telas abertas (Server-Sent Events).
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(payload);
    },
  };
  ctx.reloadSettings();
  ctx.queue = createQueue(ctx);

  const router = new Router();
  registerAuth(router, ctx);
  registerCustomers(router, ctx);
  registerOrders(router, ctx);
  registerReminders(router, ctx);
  registerChat(router, ctx);
  registerAdmin(router, ctx);

  router.get('/api/events', (req) => {
    req.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    req.res.write('retry: 3000\n\n');
    clients.add(req.res);
    const ping = setInterval(() => req.res.write(': ping\n\n'), 25000);
    req.res.on('close', () => { clearInterval(ping); clients.delete(req.res); });
    return Reply.STREAM;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const found = router.match(req.method, url.pathname);
      if (!found) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          if (serveStatic(PUBLIC_DIR, req, res, url.pathname)) return;
          if (serveStatic(PUBLIC_DIR, req, res, '/index.html')) return;
        }
        throw new HttpError(404, 'Não encontrado');
      }
      const cookies = parseCookies(req.headers.cookie);
      const user = userFromToken(db, cookies.sid);
      if (!found.route.options.public && !user) throw new HttpError(401, 'Faça login novamente');

      let rawBody = Buffer.alloc(0);
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rawBody = await readBody(req);
        if (rawBody.length) {
          try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
        }
      }
      const cookiesOut = [];
      const request = {
        params: found.params,
        query: url.searchParams,
        headers: req.headers,
        body: body && typeof body === 'object' ? body : {},
        rawBody,
        user,
        token: cookies.sid,
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
        res,
        setCookie: (c) => cookiesOut.push(c),
        text: (t) => new Reply(String(t), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
      };
      const result = await found.route.handler(request);
      if (result === Reply.STREAM) return;
      if (cookiesOut.length) res.setHeader('Set-Cookie', cookiesOut);
      if (result instanceof Reply) {
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } else sendJSON(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) sendJSON(res, status, { error: status >= 500 && !err.status ? 'Erro interno' : err.message });
      else res.end();
    }
  });

  if (scheduler) ctx.scheduler = startScheduler(ctx);
  server.on('close', () => {
    clearInterval(ctx.scheduler);
    for (const c of clients) c.end();
  });
  return { server, ctx };
}

Reply.STREAM = Symbol('stream');
