import { HttpError } from '../http.js';
import { transaction } from '../db.js';
import { firstName, isValidDate, localDate, normalizePhone, phoneKey, renderTemplate } from '../util.js';
import { getCustomer, insertCustomer } from './customers.js';
import { sendMessage } from '../services/messages.js';

export const ORDER_STATUSES = ['novo', 'saiu', 'entregue', 'cancelado'];
export const PAYMENT_METHODS = ['dinheiro', 'pix', 'debito', 'credito', 'fiado', ''];
const SOURCES = ['whatsapp', 'telefone', 'balcao', 'lembrete', 'historico'];

function withItems(db, orders) {
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.id);
  const items = db.prepare(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const o of orders) o.items = items.filter((i) => i.order_id === o.id);
  return orders;
}

function getOrder(db, id) {
  const o = db.prepare(`SELECT o.*, c.name AS customer_name, c.phone, c.address, c.neighborhood, c.reference
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return withItems(db, [o])[0];
}

function cleanItems(db, items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Adicione pelo menos um produto');
  return items.map((it) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it.product_id));
    if (!product) throw new HttpError(400, 'Produto inválido');
    const quantity = Math.max(1, Math.round(Number(it.quantity) || 1));
    const price = it.unit_price === undefined || it.unit_price === '' ? product.price : Number(it.unit_price);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Preço inválido');
    return { product_id: product.id, quantity, unit_price: price };
  });
}

export function registerOrders(router, ctx) {
  const { db } = ctx;

  router.get('/api/orders', (req) => {
    const where = ['o.historical = 0'];
    const args = [];
    const from = req.query.get('from');
    const to = req.query.get('to');
    const status = req.query.get('status');
    if (from) { where.push('o.date >= ?'); args.push(from); }
    if (to) { where.push('o.date <= ?'); args.push(to); }
    if (status === 'abertos') where.push("o.status IN ('novo', 'saiu')");
    else if (status) { where.push('o.status = ?'); args.push(status); }
    const orders = db.prepare(`SELECT o.*, c.name AS customer_name, c.phone, c.address, c.neighborhood, c.reference
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE ${where.join(' AND ')} ORDER BY o.date DESC, o.id DESC LIMIT 500`).all(...args);
    return withItems(db, orders);
  });

  router.post('/api/orders', (req) => {
    const b = req.body;
    const items = cleanItems(db, b.items);
    const date = b.date || localDate();
    if (!isValidDate(date) || date > localDate()) throw new HttpError(400, 'Data inválida');
    const status = ORDER_STATUSES.includes(b.status) ? b.status : 'novo';
    const payment = PAYMENT_METHODS.includes(b.payment_method) ? b.payment_method : '';
    const source = SOURCES.includes(b.source) ? b.source : 'balcao';
    const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);

    const id = transaction(db, () => {
      let customerId = Number(b.customer_id) || 0;
      if (!customerId) {
        const nc = b.new_customer || {};
        const name = String(nc.name ?? '').trim();
        if (!name) throw new HttpError(400, 'Escolha um cliente ou informe o nome do novo cliente');
        const phone = nc.phone ? normalizePhone(nc.phone, ctx.settings().default_ddd) : null;
        if (nc.phone && !phone) throw new HttpError(400, 'Telefone inválido');
        const existing = phone && db.prepare('SELECT id FROM customers WHERE phone_key = ?').get(phoneKey(phone));
        customerId = existing ? existing.id : insertCustomer(db, {
          name, phone, phone_key: phoneKey(phone), address: String(nc.address ?? '').trim(),
          neighborhood: String(nc.neighborhood ?? '').trim(), reference: String(nc.reference ?? '').trim(),
        });
      } else getCustomer(db, customerId);

      const { lastInsertRowid } = db.prepare(`INSERT INTO orders (customer_id, date, status, payment_method, total, notes, source, historical, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(customerId, date, status, payment, total, String(b.notes ?? ''), source, source === 'historico' ? 1 : 0, req.user.id, new Date().toISOString());
      const orderId = Number(lastInsertRowid);
      const ins = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
      for (const it of items) ins.run(orderId, it.product_id, it.quantity, it.unit_price);
      return orderId;
    });
    ctx.broadcast('orders', {});
    ctx.broadcast('reminders', {});
    return getOrder(db, id);
  });

  router.put('/api/orders/:id', async (req) => {
    const id = Number(req.params.id);
    const before = getOrder(db, id);
    const b = req.body;
    const sets = [];
    const args = [];
    if (b.status !== undefined) {
      if (!ORDER_STATUSES.includes(b.status)) throw new HttpError(400, 'Status inválido');
      sets.push('status = ?'); args.push(b.status);
    }
    if (b.payment_method !== undefined) {
      if (!PAYMENT_METHODS.includes(b.payment_method)) throw new HttpError(400, 'Forma de pagamento inválida');
      sets.push('payment_method = ?'); args.push(b.payment_method);
    }
    if (b.notes !== undefined) { sets.push('notes = ?'); args.push(String(b.notes)); }
    if (b.date !== undefined) {
      if (!isValidDate(b.date) || b.date > localDate()) throw new HttpError(400, 'Data inválida');
      sets.push('date = ?'); args.push(b.date);
    }
    transaction(db, () => {
      if (b.items !== undefined) {
        const items = cleanItems(db, b.items);
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        const ins = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
        for (const it of items) ins.run(id, it.product_id, it.quantity, it.unit_price);
        sets.push('total = ?'); args.push(items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
      }
      if (sets.length) db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    });
    const order = getOrder(db, id);

    const settings = ctx.settings();
    if (b.status === 'saiu' && before.status !== 'saiu' && settings.notify_on_dispatch && order.phone) {
      const tpl = db.prepare("SELECT body FROM templates WHERE kind = 'entrega' ORDER BY id LIMIT 1").get();
      if (tpl) {
        await sendMessage(ctx, {
          phone: order.phone, customerId: order.customer_id,
          text: renderTemplate(tpl.body, { nome: firstName(order.customer_name), loja: settings.store_name }),
        });
      }
    }
    ctx.broadcast('orders', {});
    ctx.broadcast('reminders', {});
    return order;
  });

  router.delete('/api/orders/:id', (req) => {
    db.prepare('DELETE FROM orders WHERE id = ?').run(Number(req.params.id));
    ctx.broadcast('orders', {});
    ctx.broadcast('reminders', {});
    return { ok: true };
  });
}
