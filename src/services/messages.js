// Envio e recebimento de mensagens de WhatsApp, independente do provedor.
import { formatPhone, localDate, localTime, normalizePhone, phoneKey } from '../util.js';

const DAY_MS = 86400000;

export function findCustomerByPhone(db, phone) {
  const key = phoneKey(phone);
  return key ? db.prepare('SELECT * FROM customers WHERE phone_key = ?').get(key) : undefined;
}

function insertMessage(db, m) {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO messages (customer_id, phone, phone_key, direction, body, wa_id, status, error, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.customerId ?? null, m.phone, phoneKey(m.phone), m.direction, m.body, m.waId ?? null,
      m.status, m.error ?? null, m.direction === 'out' ? 1 : 0, now);
  return getMessage(db, Number(lastInsertRowid));
}

export function getMessage(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

// A Cloud API só aceita texto livre até 24h depois da última mensagem do cliente.
export function windowOpen(db, phone) {
  const last = db.prepare("SELECT created_at FROM messages WHERE phone_key = ? AND direction = 'in' ORDER BY id DESC LIMIT 1")
    .get(phoneKey(phone));
  return Boolean(last) && Date.now() - Date.parse(last.created_at) < DAY_MS;
}

export async function sendMessage(ctx, { phone, text, customerId = null, vars = null }) {
  const { db } = ctx;
  const settings = ctx.settings();
  const to = normalizePhone(phone, settings.default_ddd);
  if (!to) throw Object.assign(new Error('Telefone inválido'), { status: 400 });
  if (!String(text ?? '').trim()) throw Object.assign(new Error('Mensagem vazia'), { status: 400 });
  const customer = customerId ? { id: customerId } : findCustomerByPhone(db, to);
  const provider = ctx.provider();

  let msg = insertMessage(db, { customerId: customer?.id, phone: to, direction: 'out', body: text, status: 'pending' });
  try {
    if (!provider) throw new Error('Nenhum WhatsApp configurado (veja Configurações)');
    const { waId } = await provider.send(to, text, { windowOpen: windowOpen(db, to), vars });
    db.prepare("UPDATE messages SET status = 'sent', wa_id = ? WHERE id = ?").run(waId, msg.id);
  } catch (err) {
    db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(String(err.message || err), msg.id);
  }
  msg = getMessage(db, msg.id);
  ctx.broadcast('message', msg);
  return msg;
}

function isOpenNow(settings) {
  const t = localTime();
  return t >= settings.business_hours_start && t < settings.business_hours_end;
}

// Processa eventos normalizados vindos do webhook de qualquer provedor.
export async function handleEvents(ctx, events) {
  const { db } = ctx;
  const settings = ctx.settings();
  for (const ev of events) {
    if (ev.type === 'status') {
      const msg = db.prepare('SELECT id FROM messages WHERE wa_id = ?').get(ev.waId);
      if (!msg) continue;
      // Não volta o status (ex.: "lida" não vira "entregue" se os eventos chegarem fora de ordem).
      const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
      const cur = db.prepare('SELECT status FROM messages WHERE id = ?').get(msg.id).status;
      if ((rank[ev.status] ?? 0) <= (rank[cur] ?? 0) && ev.status !== 'failed') continue;
      db.prepare('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?').run(ev.status, ev.error, msg.id);
      ctx.broadcast('message', getMessage(db, msg.id));
      continue;
    }
    if (ev.type !== 'message') continue;
    if (ev.waId && db.prepare('SELECT 1 FROM messages WHERE wa_id = ?').get(ev.waId)) continue; // duplicado
    const phone = normalizePhone(ev.phone) || ev.phone;

    if (ev.fromMe) {
      // Mensagem enviada pelo próprio celular da loja: só registra no histórico.
      const customer = findCustomerByPhone(db, phone);
      ctx.broadcast('message', insertMessage(db, { customerId: customer?.id, phone, direction: 'out', body: ev.body, waId: ev.waId, status: 'sent' }));
      continue;
    }

    let customer = findCustomerByPhone(db, phone);
    if (!customer) {
      const now = new Date().toISOString();
      const { lastInsertRowid } = db.prepare(`INSERT INTO customers (name, phone, phone_key, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'Cadastrado automaticamente pelo WhatsApp', ?, ?)`)
        .run(ev.name || formatPhone(phone), phone, phoneKey(phone), now, now);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(lastInsertRowid));
    }
    const msg = insertMessage(db, { customerId: customer.id, phone, direction: 'in', body: ev.body, waId: ev.waId, status: 'received' });
    ctx.broadcast('message', msg);

    // Respondeu a um lembrete recente? Marca o contato como respondido.
    const today = localDate();
    db.prepare(`UPDATE contacts SET result = 'respondeu' WHERE id = (
      SELECT id FROM contacts WHERE customer_id = ? AND result = 'enviado' AND date >= ? ORDER BY id DESC LIMIT 1)`)
      .run(customer.id, localDate(new Date(Date.now() - 3 * DAY_MS)));

    const keywords = settings.opt_out_keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.includes(ev.body.trim().toLowerCase()) && !customer.do_not_contact) {
      db.prepare('UPDATE customers SET do_not_contact = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), customer.id);
      db.prepare(`INSERT INTO contacts (customer_id, channel, result, notes, date, created_at)
        VALUES (?, 'whatsapp', 'nao_quer', 'Cliente pediu para não receber lembretes', ?, ?)`).run(customer.id, today, new Date().toISOString());
      await sendMessage(ctx, { phone, customerId: customer.id, text: 'Tudo bem! Você não vai mais receber lembretes. Quando precisar, é só chamar aqui. 👍' });
    } else if (settings.away_enabled && !isOpenNow(settings)) {
      const recentAway = db.prepare(`SELECT 1 FROM messages WHERE phone_key = ? AND direction = 'out' AND body = ? AND created_at > ?`)
        .get(phoneKey(phone), settings.away_message, new Date(Date.now() - DAY_MS / 2).toISOString());
      if (!recentAway) await sendMessage(ctx, { phone, customerId: customer.id, text: settings.away_message });
    }
  }
}
