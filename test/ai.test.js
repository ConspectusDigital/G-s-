import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { feeForDistance } from '../src/services/delivery.js';
import { saveSettings } from '../src/db.js';

// "Claude" de mentira: devolve as respostas roteirizadas, na ordem, e guarda as requisições.
function fakeClaude(script) {
  const requests = [];
  let i = 0;
  const create = async (req) => {
    requests.push(structuredClone(req));
    const step = script[i++];
    if (!step) throw new Error('roteiro acabou');
    return typeof step === 'function' ? step(req) : step;
  };
  return { requests, beta: { messages: { create } }, messages: { create } };
}
const tool = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

let app;
let base;
let cookie = '';
let claude;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('tempo esgotado');
}

const messagesOf = (phoneKey) => app.ctx.db.prepare('SELECT * FROM messages WHERE phone_key = ? ORDER BY id').all(phoneKey);

before(async () => {
  claude = fakeClaude([]);
  app = createApp({ dbPath: ':memory:', scheduler: false, aiClient: claude });
  saveSettings(app.ctx.db, { ai_enabled: true, ai_wait_seconds: 0, delivery_fee_mode: 'fixa', delivery_fee_fixed: 5, store_name: 'Gás Teste' });
  app.ctx.reloadSettings();
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  await call('/api/setup', { method: 'POST', body: { name: 'Tio', username: 'tio', password: '123456' } });
});
after(() => app.server.close());

test('cliente novo: IA cadastra, calcula a taxa e registra o pedido', async () => {
  const script = [
    tool('t1', 'salvar_dados_cliente', { nome: 'Carlos Souza', endereco: 'Rua A, 10', bairro: 'Centro', ponto_referencia: 'perto da padaria' }),
    tool('t2', 'calcular_taxa_entrega', { endereco_alternativo: '' }),
    tool('t3', 'registrar_pedido', { itens: [{ produto_id: 1, quantidade: 1 }], forma_pagamento: 'dinheiro', troco_para: 150, endereco_alternativo: '', observacoes: '', endereco_confirmado: true }),
    say('Pedido anotado, Carlos! 🙌\n\nChega aí em 30 a 60 minutos.'),
  ];
  claude.requests.length = 0;
  Object.assign(claude, fakeClaude(script));
  app.ctx.aiClient = claude;

  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11955554444', name: 'Carlão', text: 'Oi, quero um gás. Sou o Carlos, Rua A 10 Centro, perto da padaria. Pago em dinheiro, troco pra 150' } });
  const sent = await until(() => messagesOf('1155554444').filter((m) => m.sender === 'ia').length === 2 && messagesOf('1155554444'));

  // Respostas separadas em duas "bolhas", marcadas como enviadas pela IA
  assert.deepEqual(sent.filter((m) => m.direction === 'out').map((m) => m.body), ['Pedido anotado, Carlos! 🙌', 'Chega aí em 30 a 60 minutos.']);

  const customer = app.ctx.db.prepare("SELECT * FROM customers WHERE phone_key = '1155554444'").get();
  assert.equal(customer.name, 'Carlos Souza');
  assert.equal(customer.address, 'Rua A, 10');
  assert.equal(customer.reference, 'perto da padaria');

  const order = app.ctx.db.prepare('SELECT * FROM orders WHERE customer_id = ?').get(customer.id);
  assert.equal(order.delivery_fee, 5);
  assert.equal(order.total, 115);
  assert.equal(order.source, 'whatsapp');
  assert.match(order.notes, /Troco para R\$ 150,00/);

  // Formato da requisição: conversa começa com o cliente, contexto vai como mensagem de sistema
  const req = claude.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.messages[0].role, 'user');
  assert.equal(req.messages.at(-1).role, 'system');
  assert.match(req.messages.at(-1).content, /Cliente NOVO/);
  assert.match(req.messages.at(-1).content, /1: Gás P13 \(13 kg\) — R\$ 110,00/);
  // Rodadas seguintes levam os resultados das ferramentas
  const last = claude.requests[3].messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.match(last.content[0].content, /"total":"R\$ 115,00"/);
});

test('cliente sem endereço não consegue fechar pedido pela IA', async () => {
  Object.assign(claude, fakeClaude([
    tool('a1', 'registrar_pedido', { itens: [{ produto_id: 1, quantidade: 1 }], forma_pagamento: 'pix', troco_para: 0, endereco_alternativo: '', observacoes: '', endereco_confirmado: true }),
    (req) => {
      assert.match(req.messages.at(-1).content[0].content, /Cadastro incompleto/);
      assert.equal(req.messages.at(-1).content[0].is_error, true);
      return say('Claro! Qual é o seu nome e endereço?');
    },
  ]));
  app.ctx.aiClient = claude;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11933332222', text: 'manda um gás' } });
  await until(() => messagesOf('1133332222').some((m) => m.sender === 'ia'));
  assert.equal(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone_key = '1133332222'").get().n, 0);
});

test('IA chama atendente: conversa fica com humano e a IA para de responder', async () => {
  Object.assign(claude, fakeClaude([
    tool('h1', 'chamar_atendente', { motivo: 'Cliente reclamando de atraso' }),
    say('Vou chamar alguém da equipe pra te ajudar, só um instante!'),
  ]));
  app.ctx.aiClient = claude;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11922221111', text: 'meu gás não chegou ainda!!' } });
  await until(() => messagesOf('1122221111').some((m) => m.sender === 'ia'));

  let conv = (await call('/api/conversations/5511922221111')).data;
  assert.equal(conv.ai.active, false);
  assert.equal(conv.ai.needs_human, true);
  assert.equal(conv.ai.reason, 'Cliente reclamando de atraso');

  // Nova mensagem do cliente não chama a IA
  const before = claude.requests.length;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11922221111', text: 'alô?' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(claude.requests.length, before);

  // Humano devolve a conversa para a IA → ela responde a mensagem pendente
  Object.assign(claude, fakeClaude([say('Oi! Já verifiquei, seu pedido está a caminho. 🚚')]));
  app.ctx.aiClient = claude;
  await call('/api/conversations/5511922221111/ai', { method: 'POST', body: { enabled: true } });
  await until(() => messagesOf('1122221111').filter((m) => m.sender === 'ia').length === 2);
  conv = (await call('/api/conversations/5511922221111')).data;
  assert.equal(conv.ai.active, true);
  assert.equal(conv.ai.needs_human, false);
});

test('quando a loja responde manualmente, a IA pausa naquela conversa', async () => {
  Object.assign(claude, fakeClaude([say('Olá! Em que posso ajudar?')]));
  app.ctx.aiClient = claude;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11911110000', text: 'oi' } });
  await until(() => messagesOf('1111110000').some((m) => m.sender === 'ia'));

  await call('/api/conversations/5511911110000/messages', { method: 'POST', body: { text: 'Oi, aqui é o seu Zé!' } });
  const conv = (await call('/api/conversations/5511911110000')).data;
  assert.equal(conv.ai.active, false);
  assert.equal(conv.messages.at(-1).sender, 'humano');
});

test('localização enviada pelo WhatsApp fica salva no cliente', async () => {
  Object.assign(claude, fakeClaude([say('Recebi sua localização!')]));
  app.ctx.aiClient = claude;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '11900009999', lat: -23.55, lng: -46.63 } });
  const c = app.ctx.db.prepare("SELECT * FROM customers WHERE phone_key = '1100009999'").get();
  assert.equal(c.latitude, -23.55);
  assert.equal(c.location_source, 'whatsapp');
});

test('cliente já cadastrado: IA recebe o nome e só confirma o endereço', async () => {
  // Cliente cadastrado pela loja (sem o nono dígito, como às vezes chega no WhatsApp)
  await call('/api/customers', { method: 'POST', body: { name: 'Maria Aparecida Santos', phone: '(11) 96666-5555', address: 'Rua das Flores, 120', neighborhood: 'Centro' } });
  Object.assign(claude, fakeClaude([
    (req) => {
      const ctxMsg = req.messages.at(-1).content;
      assert.match(ctxMsg, /CLIENTE CADASTRADO: Maria Aparecida Santos \(chame de "Maria"; não pergunte o nome\)/);
      assert.match(ctxMsg, /Endereço do cadastro: Rua das Flores, 120, Centro\. Só confirme/);
      assert.doesNotMatch(ctxMsg, /CLIENTE NOVO/);
      assert.match(req.system[0].text, /NUNCA pergunte o nome/);
      // Tentou fechar sem confirmar o endereço
      return tool('r1', 'registrar_pedido', { itens: [{ produto_id: 1, quantidade: 1 }], forma_pagamento: 'pix', troco_para: 0, endereco_alternativo: '', observacoes: '', endereco_confirmado: false });
    },
    (req) => {
      assert.match(req.messages.at(-1).content[0].content, /Confirme com o cliente o endereço de entrega antes de registrar: Rua das Flores, 120, Centro/);
      return say('Oi, Maria! Entrego aí na Rua das Flores, 120, Centro, certo?');
    },
  ]));
  app.ctx.aiClient = claude;
  await call('/api/whatsapp/simulate', { method: 'POST', body: { phone: '551166665555', name: 'Mari', text: 'oi, manda um gás' } });
  const msgs = await until(() => messagesOf('1166665555').some((m) => m.sender === 'ia') && messagesOf('1166665555'));
  assert.equal(msgs.at(-1).body, 'Oi, Maria! Entrego aí na Rua das Flores, 120, Centro, certo?');
  // Não criou cliente duplicado nem pedido sem confirmação
  assert.equal(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone_key = '1166665555'").get().n, 1);
  assert.equal(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone_key = '1166665555'").get().n, 0);
});

test('regras da taxa de entrega', () => {
  const s = { delivery_fee_mode: 'por_distancia', delivery_fee_fixed: 5, delivery_free_km: 3, delivery_fee_per_km: 2, delivery_max_km: 10 };
  assert.equal(feeForDistance(s, 2.5).fee, 0);
  assert.equal(feeForDistance(s, 3.2).fee, 7); // 5 + 1 km excedente × 2
  assert.equal(feeForDistance(s, 6).fee, 11); // 5 + 3 × 2
  assert.equal(feeForDistance(s, 12).outOfRange, true);
  assert.equal(feeForDistance({ ...s, delivery_fee_mode: 'gratis' }, 50).fee, 0);
  assert.equal(feeForDistance({ ...s, delivery_fee_mode: 'fixa' }, null).fee, 5);
  assert.equal(feeForDistance(s, null), null);
});
