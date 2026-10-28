// Fila de envio de lembretes com intervalo entre mensagens (evita parecer spam
// e reduz o risco de bloqueio do número) e o agendador do envio automático.
import { localDate, localTime, renderTemplate } from '../util.js';
import { computeReminders, pickTemplate, reminderVars } from './reminders.js';
import { sendMessage } from './messages.js';

export function logContact(db, { customerId, productId = null, channel, result, snoozeDays = 0, notes = '', userId = null }) {
  const today = localDate();
  const snooze = snoozeDays > 0 ? localDate(new Date(Date.now() + snoozeDays * 86400000)) : null;
  const { lastInsertRowid } = db.prepare(`INSERT INTO contacts (customer_id, product_id, channel, result, snooze_until, notes, user_id, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(customerId, productId, channel, result, snooze, notes, userId, today, new Date().toISOString());
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(lastInsertRowid));
}

// Envia o lembrete de um item (cliente + produto) e registra o contato.
export async function sendReminder(ctx, item, { text = null, templateId = null, userId = null, channel = 'whatsapp' } = {}) {
  const settings = ctx.settings();
  const vars = reminderVars(item, settings);
  let body = text;
  if (!body) {
    const tpl = templateId ? ctx.db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) : pickTemplate(ctx.db, item);
    if (!tpl) throw Object.assign(new Error('Nenhum modelo de mensagem cadastrado'), { status: 400 });
    body = renderTemplate(tpl.body, vars);
  }
  const msg = await sendMessage(ctx, { phone: item.phone, text: body, customerId: item.customer_id, vars });
  if (msg.status !== 'failed') {
    logContact(ctx.db, { customerId: item.customer_id, productId: item.product_id, channel, result: 'enviado', userId });
    ctx.broadcast('reminders', {});
  }
  return msg;
}

export function createQueue(ctx) {
  const jobs = [];
  let running = false;

  function delayMs() {
    const s = ctx.settings();
    if (s.wa_provider === 'simulator') return 300;
    const min = Math.max(5, s.send_delay_min);
    const max = Math.max(min, s.send_delay_max);
    return (min + Math.random() * (max - min)) * 1000;
  }

  async function run() {
    if (running) return;
    running = true;
    while (jobs.length) {
      const job = jobs.shift();
      try {
        const fresh = computeReminders(ctx.db, ctx.settings(), { customerId: job.item.customer_id })
          .find((r) => r.product_id === job.item.product_id);
        // Pode ter comprado ou sido contatado enquanto esperava na fila.
        if (fresh && ['chamar', 'inativo'].includes(fresh.status) && fresh.phone) {
          await sendReminder(ctx, fresh, job.options);
        }
      } catch (err) {
        console.error('Falha no envio de lembrete:', err.message);
      }
      ctx.broadcast('queue', { pending: jobs.length });
      if (jobs.length) await new Promise((r) => setTimeout(r, delayMs()));
    }
    running = false;
  }

  return {
    get pending() { return jobs.length; },
    has(customerId) { return jobs.some((j) => j.item.customer_id === customerId); },
    add(items, options = {}) {
      let added = 0;
      for (const item of items) {
        if (!item.phone || this.has(item.customer_id)) continue;
        jobs.push({ item, options });
        added++;
      }
      ctx.broadcast('queue', { pending: jobs.length });
      run();
      return added;
    },
  };
}

export function runAutoSend(ctx, now = new Date()) {
  const s = ctx.settings();
  if (!s.auto_send || !ctx.provider()) return 0;
  const time = localTime(now);
  if (!s.auto_send_days.includes(now.getDay()) || time < s.auto_send_start || time >= s.auto_send_end) return 0;

  const today = localDate(now);
  const sentToday = ctx.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'whatsapp_auto' AND date = ?").get(today).n;
  let remaining = s.auto_send_daily_limit - sentToday - ctx.queue.pending;
  if (remaining <= 0) return 0;

  const seen = new Set();
  const items = computeReminders(ctx.db, s, { today }).filter((r) => {
    const ok = (r.status === 'chamar' || (s.auto_send_include_inactive && r.status === 'inativo'))
      && r.phone && r.autoAttempts < s.auto_send_max_attempts && !seen.has(r.customer_id);
    if (ok) seen.add(r.customer_id);
    return ok;
  }).slice(0, remaining);
  return ctx.queue.add(items, { channel: 'whatsapp_auto' });
}

export function startScheduler(ctx) {
  const tick = () => {
    try { runAutoSend(ctx); } catch (err) { console.error('Erro no envio automático:', err.message); }
    // Limpa sessões expiradas.
    ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  setTimeout(tick, 10000).unref();
  return timer;
}
