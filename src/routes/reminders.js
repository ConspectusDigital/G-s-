import { HttpError } from '../http.js';
import { computeReminders, pickTemplate, reminderVars } from '../services/reminders.js';
import { logContact, sendReminder } from '../services/autosend.js';
import { renderTemplate } from '../util.js';

const CHANNELS = ['whatsapp', 'whatsapp_auto', 'ligacao', 'presencial', 'outro'];
const RESULTS = ['enviado', 'respondeu', 'vai_comprar', 'sem_resposta', 'nao_atendeu', 'nao_quer', 'adiado', 'comprou'];

export function registerReminders(router, ctx) {
  const { db } = ctx;

  const findItem = (customerId, productId) => {
    const item = computeReminders(db, ctx.settings(), { customerId }).find((r) => r.product_id === productId);
    if (!item) throw new HttpError(404, 'Esse cliente ainda não tem compra registrada desse produto');
    return item;
  };

  router.get('/api/reminders', () => {
    const items = computeReminders(db, ctx.settings());
    const counts = {};
    for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
    return { items, counts, queue: ctx.queue.pending };
  });

  // Pré-visualiza a mensagem que será enviada para um cliente.
  router.get('/api/reminders/preview', (req) => {
    const item = findItem(Number(req.query.get('customer_id')), Number(req.query.get('product_id')));
    const templateId = Number(req.query.get('template_id')) || 0;
    const tpl = templateId ? db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) : pickTemplate(db, item);
    return { template_id: tpl?.id ?? null, text: tpl ? renderTemplate(tpl.body, reminderVars(item, ctx.settings())) : '' };
  });

  router.post('/api/reminders/send', async (req) => {
    const item = findItem(Number(req.body.customer_id), Number(req.body.product_id));
    if (!item.phone) throw new HttpError(400, 'Cliente sem telefone cadastrado');
    if (item.status === 'bloqueado') throw new HttpError(400, 'Esse cliente pediu para não receber lembretes');
    const msg = await sendReminder(ctx, item, {
      text: req.body.text || null, templateId: Number(req.body.template_id) || null, userId: req.user.id,
    });
    if (msg.status === 'failed') throw new HttpError(502, 'Não foi possível enviar: ' + msg.error);
    return msg;
  });

  // Envia para vários de uma vez, com intervalo entre as mensagens.
  router.post('/api/reminders/send-bulk', (req) => {
    const wanted = new Set((req.body.items || []).map((i) => `${i.customer_id}:${i.product_id}`));
    const items = computeReminders(db, ctx.settings())
      .filter((r) => wanted.has(`${r.customer_id}:${r.product_id}`) && ['chamar', 'inativo'].includes(r.status) && r.phone);
    const added = ctx.queue.add(items, { userId: req.user.id, channel: 'whatsapp' });
    return { added, pending: ctx.queue.pending };
  });

  router.post('/api/contacts', (req) => {
    const b = req.body;
    if (!CHANNELS.includes(b.channel)) throw new HttpError(400, 'Canal inválido');
    if (!RESULTS.includes(b.result)) throw new HttpError(400, 'Resultado inválido');
    const customerId = Number(b.customer_id);
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw new HttpError(404, 'Cliente não encontrado');
    const contact = logContact(db, {
      customerId, productId: Number(b.product_id) || null, channel: b.channel, result: b.result,
      snoozeDays: Math.min(180, Math.max(0, Number(b.snooze_days) || 0)), notes: String(b.notes ?? ''), userId: req.user.id,
    });
    if (b.result === 'nao_quer' && b.block) {
      db.prepare('UPDATE customers SET do_not_contact = 1 WHERE id = ?').run(customerId);
    }
    ctx.broadcast('reminders', {});
    return contact;
  });
}
