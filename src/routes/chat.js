import { HttpError } from '../http.js';
import { handleEvents, sendMessage } from '../services/messages.js';
import { normalizePhone, phoneKey } from '../util.js';
import { parseCloudWebhook } from '../whatsapp/cloud.js';
import { parseEvolutionWebhook } from '../whatsapp/evolution.js';
import { computeReminders } from '../services/reminders.js';

export function registerChat(router, ctx) {
  const { db } = ctx;

  router.get('/api/conversations', (req) => {
    const q = (req.query.get('q') || '').trim();
    const rows = db.prepare(`
      SELECT m.phone_key, m.phone, m.body AS last_body, m.direction AS last_direction, m.status AS last_status, m.created_at AS last_at,
        c.id AS customer_id, c.name AS customer_name,
        (SELECT COUNT(*) FROM messages u WHERE u.phone_key = m.phone_key AND u.direction = 'in' AND u.read = 0) AS unread
      FROM messages m
      JOIN (SELECT phone_key, MAX(id) AS id FROM messages GROUP BY phone_key) last ON last.id = m.id
      LEFT JOIN customers c ON c.phone_key = m.phone_key
      ORDER BY m.id DESC LIMIT 300`).all();
    if (!q) return rows;
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, '');
    return rows.filter((r) => (r.customer_name || '').toLowerCase().includes(lower) || (digits && r.phone.includes(digits)));
  });

  router.get('/api/conversations/:phone', (req) => {
    const phone = normalizePhone(req.params.phone) || req.params.phone;
    const key = phoneKey(phone);
    const before = Number(req.query.get('before')) || Number.MAX_SAFE_INTEGER;
    const messages = db.prepare('SELECT * FROM messages WHERE phone_key = ? AND id < ? ORDER BY id DESC LIMIT 100')
      .all(key, before).reverse();
    const customer = db.prepare('SELECT * FROM customers WHERE phone_key = ?').get(key) || null;
    const reminders = customer ? computeReminders(db, ctx.settings(), { customerId: customer.id }) : [];
    const lastOrder = customer
      ? db.prepare("SELECT date, total FROM orders WHERE customer_id = ? AND status != 'cancelado' ORDER BY date DESC, id DESC LIMIT 1").get(customer.id)
      : null;
    return { phone, key, messages, customer, reminders, lastOrder: lastOrder || null };
  });

  router.post('/api/conversations/:phone/read', (req) => {
    db.prepare("UPDATE messages SET read = 1 WHERE phone_key = ? AND direction = 'in' AND read = 0").run(phoneKey(req.params.phone));
    ctx.broadcast('read', { phone_key: phoneKey(req.params.phone) });
    return { ok: true };
  });

  router.post('/api/conversations/:phone/messages', async (req) => {
    const msg = await sendMessage(ctx, { phone: req.params.phone, text: String(req.body.text ?? '').trim() });
    return msg;
  });

  router.get('/api/whatsapp/status', async () => {
    const settings = ctx.settings();
    const provider = ctx.provider();
    const base = { provider: settings.wa_provider, queue: ctx.queue.pending };
    if (!provider) return { ...base, connected: false, state: 'desativado' };
    if (!provider.status) return { ...base, connected: Boolean(settings.cloud_token && settings.cloud_phone_number_id), state: 'api oficial' };
    try {
      return { ...base, ...(await provider.status()) };
    } catch (err) {
      return { ...base, connected: false, state: 'erro', error: err.message };
    }
  });

  router.get('/api/whatsapp/qrcode', async () => {
    const provider = ctx.provider();
    if (!provider?.qrcode) throw new HttpError(400, 'QR Code só existe para a Evolution API');
    try {
      return await provider.qrcode();
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  });

  // Simula uma mensagem recebida (só no modo simulador) para testar o atendimento.
  router.post('/api/whatsapp/simulate', async (req) => {
    if (ctx.settings().wa_provider !== 'simulator') throw new HttpError(400, 'Disponível apenas no modo simulador');
    const phone = normalizePhone(req.body.phone, ctx.settings().default_ddd);
    if (!phone) throw new HttpError(400, 'Telefone inválido');
    await handleEvents(ctx, [{
      type: 'message', phone, name: String(req.body.name || '').trim() || null,
      body: String(req.body.text || '').trim() || 'Oi, quero um gás', waId: 'sim-in-' + Date.now() + Math.random(), fromMe: false,
    }]);
    return { ok: true };
  });

  // ---- Webhooks (públicos, chamados pela Meta / Evolution) ----

  router.get('/webhook/cloud', (req) => {
    const settings = ctx.settings();
    const ok = req.query.get('hub.mode') === 'subscribe' && req.query.get('hub.verify_token') === settings.cloud_verify_token;
    if (!ok) throw new HttpError(403, 'Token de verificação inválido');
    return req.text(req.query.get('hub.challenge') || '');
  }, { public: true });

  router.post('/webhook/cloud', async (req) => {
    const settings = ctx.settings();
    if (settings.wa_provider !== 'cloud') return { ignored: true };
    const provider = ctx.provider();
    if (!provider.verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) throw new HttpError(401, 'Assinatura inválida');
    await handleEvents(ctx, parseCloudWebhook(req.body));
    return { ok: true };
  }, { public: true });

  const evolutionWebhook = async (req) => {
    const settings = ctx.settings();
    if (req.query.get('token') !== settings.webhook_secret) throw new HttpError(401, 'Token inválido');
    if (settings.wa_provider !== 'evolution') return { ignored: true };
    await handleEvents(ctx, parseEvolutionWebhook(req.body));
    return { ok: true };
  };
  router.post('/webhook/evolution', evolutionWebhook, { public: true });
  // Com "Webhook by Events" ligado, a Evolution acrescenta o nome do evento na URL.
  router.post('/webhook/evolution/:event', evolutionWebhook, { public: true });
}
