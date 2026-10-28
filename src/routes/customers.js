import { HttpError, Reply } from '../http.js';
import { transaction } from '../db.js';
import { localDate, normalizePhone, parseBrDate, parseCSV, phoneKey, toCSV } from '../util.js';
import { computeReminders } from '../services/reminders.js';

const FIELDS = ['name', 'address', 'neighborhood', 'reference', 'notes'];

export function getCustomer(db, id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Cliente não encontrado');
  return c;
}

function cleanCustomer(body, settings) {
  const data = {};
  for (const f of FIELDS) if (f in body) data[f] = String(body[f] ?? '').trim();
  if ('name' in data && !data.name) throw new HttpError(400, 'Informe o nome do cliente');
  if ('phone' in body) {
    const raw = String(body.phone ?? '').trim();
    data.phone = raw ? normalizePhone(raw, settings.default_ddd) : null;
    if (raw && !data.phone) throw new HttpError(400, 'Telefone inválido. Use DDD + número, ex.: (11) 98765-4321');
    data.phone_key = phoneKey(data.phone);
  }
  if ('do_not_contact' in body) data.do_not_contact = body.do_not_contact ? 1 : 0;
  return data;
}

function assertPhoneFree(db, key, exceptId = 0) {
  if (!key) return;
  const other = db.prepare('SELECT id, name FROM customers WHERE phone_key = ? AND id != ?').get(key, exceptId);
  if (other) throw new HttpError(409, `Esse telefone já pertence ao cliente "${other.name}"`);
}

export function insertCustomer(db, data) {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`INSERT INTO customers
    (name, phone, phone_key, address, neighborhood, reference, notes, do_not_contact, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(data.name, data.phone ?? null, data.phone_key ?? null, data.address ?? '', data.neighborhood ?? '',
      data.reference ?? '', data.notes ?? '', data.do_not_contact ?? 0, now, now);
  return Number(lastInsertRowid);
}

// Registra a última compra conhecida de um cliente antigo, para o sistema já saber quando chamar.
export function insertHistoricalPurchase(db, customerId, { date, productId, quantity = 1 }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new HttpError(400, 'Produto inválido');
  const { lastInsertRowid } = db.prepare(`INSERT INTO orders (customer_id, date, status, total, notes, source, historical, created_at)
    VALUES (?, ?, 'entregue', 0, 'Compra anterior ao sistema', 'historico', 1, ?)`)
    .run(customerId, date, new Date().toISOString());
  db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, 0)')
    .run(Number(lastInsertRowid), productId, Math.max(1, Number(quantity) || 1));
}

export function registerCustomers(router, ctx) {
  const { db } = ctx;

  router.get('/api/customers', (req) => {
    const q = (req.query.get('q') || '').trim();
    const limit = Math.min(200, Number(req.query.get('limit')) || 50);
    const offset = Number(req.query.get('offset')) || 0;
    const args = [];
    let where = '';
    if (q) {
      const digits = q.replace(/\D/g, '');
      where = 'WHERE c.name LIKE ? OR c.address LIKE ? OR c.neighborhood LIKE ?' + (digits.length >= 3 ? ' OR c.phone LIKE ?' : '');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
      if (digits.length >= 3) args.push(`%${digits}%`);
    }
    const rows = db.prepare(`SELECT c.*,
        (SELECT MAX(date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelado') AS last_order,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelado') AS order_count
      FROM customers c ${where} ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...args).n;
    return { rows, total };
  });

  router.post('/api/customers', (req) => {
    const data = cleanCustomer({ name: '', ...req.body }, ctx.settings());
    assertPhoneFree(db, data.phone_key);
    const lp = req.body.last_purchase;
    return transaction(db, () => {
      const id = insertCustomer(db, data);
      if (lp?.date) {
        const date = parseBrDate(lp.date);
        if (!date || date > localDate()) throw new HttpError(400, 'Data da última compra inválida');
        insertHistoricalPurchase(db, id, { date, productId: Number(lp.product_id), quantity: lp.quantity });
      }
      return getCustomer(db, id);
    });
  });

  router.get('/api/customers/export.csv', () => {
    const rows = db.prepare(`SELECT c.*, (SELECT MAX(date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelado') AS last_order
      FROM customers c ORDER BY c.name`).all();
    const csv = toCSV([
      ['nome', 'telefone', 'endereco', 'bairro', 'referencia', 'observacoes', 'ultima_compra', 'nao_contatar'],
      ...rows.map((c) => [c.name, c.phone, c.address, c.neighborhood, c.reference, c.notes,
        c.last_order ? c.last_order.split('-').reverse().join('/') : '', c.do_not_contact ? 'sim' : '']),
    ]);
    return new Reply('﻿' + csv, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="clientes-${localDate()}.csv"` },
    });
  });

  // Importa planilha (CSV) com colunas: nome, telefone, endereco, bairro, referencia, observacoes, ultima_compra, produto, quantidade.
  router.post('/api/customers/import', (req) => {
    const rows = parseCSV(String(req.body.csv ?? ''));
    if (rows.length < 2) throw new HttpError(400, 'A planilha precisa ter cabeçalho e pelo menos uma linha');
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
    const header = rows[0].map(norm);
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const idx = {
      name: col('nome', 'cliente', 'name'), phone: col('telefone', 'celular', 'whatsapp', 'fone', 'phone'),
      address: col('endereco', 'rua', 'address'), neighborhood: col('bairro'), reference: col('referencia', 'ponto_de_referencia'),
      notes: col('observacoes', 'observacao', 'obs'), last: col('ultima_compra', 'data_ultima_compra', 'data'),
      product: col('produto'), quantity: col('quantidade', 'qtd'),
    };
    if (idx.name < 0) throw new HttpError(400, 'Não encontrei a coluna "nome" no cabeçalho');
    const products = db.prepare('SELECT id, name, cycle_days FROM products WHERE active = 1').all();
    const defaultProduct = products.find((p) => p.cycle_days != null);
    const settings = ctx.settings();
    const report = { created: 0, updated: 0, skipped: 0, errors: [] };
    const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');

    transaction(db, () => {
      rows.slice(1).forEach((r, n) => {
        const line = n + 2;
        const name = get(r, idx.name);
        if (!name) { report.skipped++; return; }
        const phoneRaw = get(r, idx.phone);
        const phone = phoneRaw ? normalizePhone(phoneRaw, settings.default_ddd) : null;
        if (phoneRaw && !phone) report.errors.push(`Linha ${line}: telefone "${phoneRaw}" inválido (importado sem telefone)`);
        const data = {
          name, phone, phone_key: phoneKey(phone), address: get(r, idx.address), neighborhood: get(r, idx.neighborhood),
          reference: get(r, idx.reference), notes: get(r, idx.notes),
        };
        const existing = data.phone_key ? db.prepare('SELECT id FROM customers WHERE phone_key = ?').get(data.phone_key) : null;
        let id;
        if (existing) {
          id = existing.id;
          db.prepare(`UPDATE customers SET name = ?, address = COALESCE(NULLIF(?, ''), address), neighborhood = COALESCE(NULLIF(?, ''), neighborhood),
            reference = COALESCE(NULLIF(?, ''), reference), notes = COALESCE(NULLIF(?, ''), notes), updated_at = ? WHERE id = ?`)
            .run(name, data.address, data.neighborhood, data.reference, data.notes, new Date().toISOString(), id);
          report.updated++;
        } else {
          id = insertCustomer(db, data);
          report.created++;
        }
        const lastRaw = get(r, idx.last);
        if (lastRaw) {
          const date = parseBrDate(lastRaw);
          const pname = get(r, idx.product).toLowerCase();
          const product = (pname && products.find((p) => p.name.toLowerCase().includes(pname))) || defaultProduct;
          if (!date) report.errors.push(`Linha ${line}: data "${lastRaw}" inválida (use dd/mm/aaaa)`);
          else if (product && !db.prepare('SELECT 1 FROM orders WHERE customer_id = ? AND date = ?').get(id, date)) {
            insertHistoricalPurchase(db, id, { date, productId: product.id, quantity: Number(get(r, idx.quantity)) || 1 });
          }
        }
      });
    });
    ctx.broadcast('reminders', {});
    return report;
  });

  router.get('/api/customers/:id', (req) => {
    const id = Number(req.params.id);
    const customer = getCustomer(db, id);
    const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY date DESC, id DESC LIMIT 100').all(id);
    const items = db.prepare(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (SELECT id FROM orders WHERE customer_id = ?)`).all(id);
    for (const o of orders) o.items = items.filter((i) => i.order_id === o.id);
    const contacts = db.prepare(`SELECT c.*, p.name AS product_name, u.name AS user_name FROM contacts c
      LEFT JOIN products p ON p.id = c.product_id LEFT JOIN users u ON u.id = c.user_id
      WHERE c.customer_id = ? ORDER BY c.created_at DESC LIMIT 50`).all(id);
    const manual = db.prepare('SELECT product_id, days FROM customer_cycles WHERE customer_id = ?').all(id);
    const stats = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue FROM orders
      WHERE customer_id = ? AND status != 'cancelado' AND historical = 0`).get(id);
    return { customer, orders, contacts, manual, stats, reminders: computeReminders(db, ctx.settings(), { customerId: id }) };
  });

  router.put('/api/customers/:id', (req) => {
    const id = Number(req.params.id);
    getCustomer(db, id);
    const data = cleanCustomer(req.body, ctx.settings());
    if ('phone_key' in data) assertPhoneFree(db, data.phone_key, id);
    const keys = Object.keys(data);
    const current = getCustomer(db, id);
    // Endereço mudou: a localização calculada a partir do endereço antigo deixa de valer.
    if (current.location_source === 'endereco' && ((data.address ?? current.address) !== current.address
      || (data.neighborhood ?? current.neighborhood) !== current.neighborhood)) {
      db.prepare("UPDATE customers SET latitude = NULL, longitude = NULL, location_source = '' WHERE id = ?").run(id);
    }
    if (keys.length) {
      db.prepare(`UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), new Date().toISOString(), id);
      // Mensagens antigas desse número passam a apontar para o cliente.
      if (data.phone_key) db.prepare('UPDATE messages SET customer_id = ? WHERE phone_key = ?').run(id, data.phone_key);
    }
    ctx.broadcast('reminders', {});
    return getCustomer(db, id);
  });

  router.delete('/api/customers/:id', (req) => {
    db.prepare('DELETE FROM customers WHERE id = ?').run(Number(req.params.id));
    ctx.broadcast('reminders', {});
    return { ok: true };
  });

  // Define (ou remove, com days vazio) o ciclo manual de um produto para o cliente.
  router.put('/api/customers/:id/cycles/:productId', (req) => {
    const id = Number(req.params.id);
    const productId = Number(req.params.productId);
    const days = Number(req.body.days) || 0;
    if (days) {
      if (days < 3 || days > 365) throw new HttpError(400, 'O ciclo deve ficar entre 3 e 365 dias');
      db.prepare(`INSERT INTO customer_cycles (customer_id, product_id, days) VALUES (?, ?, ?)
        ON CONFLICT(customer_id, product_id) DO UPDATE SET days = excluded.days`).run(id, productId, days);
    } else {
      db.prepare('DELETE FROM customer_cycles WHERE customer_id = ? AND product_id = ?').run(id, productId);
    }
    ctx.broadcast('reminders', {});
    return { ok: true };
  });
}
