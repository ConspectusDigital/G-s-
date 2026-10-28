import { HttpError } from '../http.js';
import { DEFAULT_SETTINGS, SECRET_SETTINGS, getSettings, saveSettings } from '../db.js';
import { addDays, localDate } from '../util.js';
import { computeReminders } from '../services/reminders.js';

const MASK = '••••••••';
const TEMPLATE_KINDS = ['lembrete', 'reconquista', 'entrega', 'resposta'];

export function registerAdmin(router, ctx) {
  const { db } = ctx;

  router.get('/api/settings', (req) => {
    const s = getSettings(db);
    for (const k of SECRET_SETTINGS) if (s[k]) s[k] = MASK;
    const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    return {
      settings: s,
      webhooks: {
        cloud: `${origin}/webhook/cloud`,
        evolution: `${origin}/webhook/evolution?token=${s.webhook_secret}`,
      },
    };
  });

  router.put('/api/settings', (req) => {
    const patch = { ...req.body };
    for (const k of SECRET_SETTINGS) if (patch[k] === MASK) delete patch[k];
    for (const k of ['auto_send_start', 'auto_send_end', 'business_hours_start', 'business_hours_end']) {
      if (k in patch && !/^\d{2}:\d{2}$/.test(patch[k])) throw new HttpError(400, 'Horário inválido (use HH:MM)');
    }
    if ('timezone' in patch) {
      try { new Intl.DateTimeFormat('pt-BR', { timeZone: patch.timezone }); } catch { throw new HttpError(400, 'Fuso horário inválido'); }
    }
    for (const k of ['lead_days', 'recontact_days', 'inactive_grace_days', 'conversion_window_days', 'auto_send_daily_limit', 'auto_send_max_attempts']) {
      if (k in patch && (!Number.isFinite(Number(patch[k])) || Number(patch[k]) < 0)) throw new HttpError(400, 'Valor numérico inválido');
    }
    saveSettings(db, patch);
    ctx.reloadSettings();
    ctx.broadcast('reminders', {});
    return { ok: true };
  });

  router.get('/api/settings/defaults', () => DEFAULT_SETTINGS);

  // ---- Produtos ----
  router.get('/api/products', () => db.prepare('SELECT * FROM products ORDER BY active DESC, name').all());

  const cleanProduct = (b) => {
    const name = String(b.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Informe o nome do produto');
    const price = Number(b.price) || 0;
    const cycle = b.cycle_days === '' || b.cycle_days == null ? null : Math.round(Number(b.cycle_days));
    if (cycle !== null && (!(cycle >= 3) || cycle > 365)) throw new HttpError(400, 'Duração deve ficar entre 3 e 365 dias (ou vazio)');
    return [name, price, cycle, b.active === false || b.active === 0 ? 0 : 1];
  };

  router.post('/api/products', (req) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO products (name, price, cycle_days, active) VALUES (?, ?, ?, ?)').run(...cleanProduct(req.body));
    return db.prepare('SELECT * FROM products WHERE id = ?').get(Number(lastInsertRowid));
  });

  router.put('/api/products/:id', (req) => {
    db.prepare('UPDATE products SET name = ?, price = ?, cycle_days = ?, active = ? WHERE id = ?').run(...cleanProduct(req.body), Number(req.params.id));
    ctx.broadcast('reminders', {});
    return db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  });

  // ---- Modelos de mensagem ----
  router.get('/api/templates', () => db.prepare('SELECT * FROM templates ORDER BY kind, name').all());

  const cleanTemplate = (b) => {
    const name = String(b.name ?? '').trim();
    const body = String(b.body ?? '').trim();
    if (!name || !body) throw new HttpError(400, 'Informe nome e texto do modelo');
    return [name, TEMPLATE_KINDS.includes(b.kind) ? b.kind : 'resposta', body];
  };

  router.post('/api/templates', (req) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO templates (name, kind, body) VALUES (?, ?, ?)').run(...cleanTemplate(req.body));
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(lastInsertRowid));
  });

  router.put('/api/templates/:id', (req) => {
    db.prepare('UPDATE templates SET name = ?, kind = ?, body = ? WHERE id = ?').run(...cleanTemplate(req.body), Number(req.params.id));
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  });

  router.delete('/api/templates/:id', (req) => {
    db.prepare('DELETE FROM templates WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // ---- Painel ----
  router.get('/api/dashboard', () => {
    const settings = ctx.settings();
    const today = localDate();
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthStart = addDays(monthStart, -1).slice(0, 8) + '01';
    const prevMonthSameDay = addDays(prevMonthStart, Number(today.slice(8)) - 1);
    const sales = (from, to) => db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue FROM orders
      WHERE historical = 0 AND status != 'cancelado' AND date >= ? AND date <= ?`).get(from, to);

    const series = db.prepare(`SELECT date, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue FROM orders
      WHERE historical = 0 AND status != 'cancelado' AND date >= ? GROUP BY date ORDER BY date`).all(addDays(today, -29));
    const byDate = new Map(series.map((s) => [s.date, s]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const d = addDays(today, i - 29);
      return byDate.get(d) || { date: d, orders: 0, revenue: 0 };
    });

    // Vendas que aconteceram até N dias depois de um lembrete para o mesmo cliente.
    const conversion = db.prepare(`
      SELECT COUNT(DISTINCT c.id) AS contacted,
        COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN c.id END) AS converted
      FROM contacts c
      LEFT JOIN orders o ON o.customer_id = c.customer_id AND o.historical = 0 AND o.status != 'cancelado'
        AND o.date >= c.date AND o.date <= date(c.date, '+' || ? || ' days')
      WHERE c.date >= ? AND c.channel IN ('whatsapp', 'whatsapp_auto', 'ligacao', 'presencial', 'outro')
        AND c.result NOT IN ('adiado')`).get(settings.conversion_window_days, monthStart);
    const recovered = db.prepare(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue FROM orders o
      WHERE o.historical = 0 AND o.status != 'cancelado' AND o.date >= ?
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.customer_id = o.customer_id AND c.result != 'adiado'
          AND c.date <= o.date AND o.date <= date(c.date, '+' || ? || ' days'))`).get(monthStart, settings.conversion_window_days);

    const reminders = computeReminders(db, settings);
    const counts = {};
    for (const r of reminders) counts[r.status] = (counts[r.status] || 0) + 1;
    const upcoming = reminders.filter((r) => r.status === 'em_dia' && r.daysToDue <= settings.lead_days + 7).length;

    return {
      today: sales(today, today),
      month: sales(monthStart, today),
      prevMonth: sales(prevMonthStart, prevMonthSameDay),
      openOrders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('novo', 'saiu') AND historical = 0").get().n,
      unread: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND read = 0").get().n,
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      counts,
      upcoming,
      conversion,
      recovered,
      daily,
      callList: reminders.filter((r) => r.status === 'chamar').slice(0, 8),
    };
  });
}
