import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { addDays, localDate } from '../src/util.js';

let server;
let base;
let cookie = '';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:', scheduler: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('fluxo completo: cadastro, lembrete, mensagem e venda', async () => {
  assert.equal((await call('/api/customers')).status, 401);
  assert.equal((await call('/api/setup', { method: 'POST', body: { name: 'Tio', username: 'tio', password: '123456' } })).status, 200);
  assert.equal((await call('/api/setup', { method: 'POST', body: { name: 'X', username: 'x', password: '123456' } })).status, 403);

  const lastPurchase = addDays(localDate(), -42);
  const c = await call('/api/customers', {
    method: 'POST',
    body: { name: 'Maria Silva', phone: '(11) 98765-4321', last_purchase: { date: lastPurchase, product_id: 1 } },
  });
  assert.equal(c.status, 200);
  const dup = await call('/api/customers', { method: 'POST', body: { name: 'Outra', phone: '11 98765-4321' } });
  assert.equal(dup.status, 409);

  let rem = await call('/api/reminders');
  assert.equal(rem.data.items[0].status, 'chamar');

  const sent = await call('/api/reminders/send', { method: 'POST', body: { customer_id: c.data.id, product_id: 1 } });
  assert.equal(sent.status, 200);
  assert.match(sent.data.body, /Maria/);
  rem = await call('/api/reminders');
  assert.equal(rem.data.items[0].status, 'aguardando');

  // Cliente responde (sem o nono dígito, como às vezes chega do WhatsApp)
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '551187654321', text: 'Quero sim' } });
  const conv = await call('/api/conversations');
  assert.equal(conv.data.length, 1);
  assert.equal(conv.data[0].customer_name, 'Maria Silva');
  assert.equal(conv.data[0].unread, 1);

  const order = await call('/api/orders', {
    method: 'POST', body: { customer_id: c.data.id, items: [{ product_id: 1, quantity: 1 }], payment_method: 'pix', source: 'lembrete' },
  });
  assert.equal(order.data.total, 110);
  rem = await call('/api/reminders');
  assert.equal(rem.data.items[0].status, 'em_dia');

  const dash = await call('/api/dashboard');
  assert.equal(dash.data.recovered.orders, 1);
  assert.equal(dash.data.today.revenue, 110);
});

test('opt-out: cliente que responde SAIR não recebe mais lembretes', async () => {
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11911112222', name: 'José', text: 'SAIR' } });
  const { data } = await call('/api/customers?q=José');
  assert.equal(data.rows[0].do_not_contact, 1);
});

test('importação de planilha', async () => {
  const csv = 'Nome;Telefone;Bairro;Última compra\nAna Souza;(11) 97777-0000;Centro;01/09/2026\nSem Fone;;;\n';
  const r = await call('/api/customers/import', { method: 'POST', body: { csv } });
  assert.equal(r.data.created, 2);
  const again = await call('/api/customers/import', { method: 'POST', body: { csv } });
  assert.equal(again.data.updated, 1);
});
