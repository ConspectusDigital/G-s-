// IA de atendimento no WhatsApp (Claude, via API da Anthropic).
// Responde clientes novos e antigos, cadastra nome/endereço, calcula a taxa de entrega,
// registra pedidos e chama um humano quando precisa. Pode ser desligada por conversa.
import Anthropic from '@anthropic-ai/sdk';
import { formatPhone, localDate, localTime, phoneKey } from '../util.js';
import { feeForDistance, quoteDelivery } from './delivery.js';
import { sendMessage } from './messages.js';

const HISTORY_LIMIT = 40;
const HISTORY_DAYS = 3;
const MAX_TOOL_ROUNDS = 6;
const AUTO_NOTE = 'Cadastrado automaticamente pelo WhatsApp';
const PAYMENTS = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Cartão de débito', credito: 'Cartão de crédito' };

// ---------- Estado da IA por conversa ----------

export function getChatState(db, key) {
  return db.prepare('SELECT * FROM chat_settings WHERE phone_key = ?').get(key)
    || { phone_key: key, ai_enabled: null, needs_human: 0, handoff_reason: '' };
}

export function setChatState(db, key, patch) {
  const cur = getChatState(db, key);
  const next = { ...cur, ...patch };
  db.prepare(`INSERT INTO chat_settings (phone_key, ai_enabled, needs_human, handoff_reason, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone_key) DO UPDATE SET ai_enabled = excluded.ai_enabled, needs_human = excluded.needs_human,
      handoff_reason = excluded.handoff_reason, updated_at = excluded.updated_at`)
    .run(key, next.ai_enabled, next.needs_human ? 1 : 0, next.handoff_reason || '', new Date().toISOString());
  return getChatState(db, key);
}

// A IA atende uma conversa se estiver ligada no geral e não tiver sido desligada nela.
export function aiActiveFor(ctx, key) {
  return Boolean(ctx.settings().ai_enabled) && getChatState(ctx.db, key).ai_enabled !== 0;
}

// ---------- Instruções e ferramentas ----------

function systemPrompt(settings) {
  return `Você é ${settings.ai_name}, atendente virtual da loja "${settings.store_name}", uma revenda de gás de cozinha (botijões) e água mineral, atendendo pelo WhatsApp.

Seu objetivo é atender bem e fechar a venda: entender o que o cliente precisa, cadastrar quem é novo, informar preço e taxa de entrega, confirmar o pedido e registrá-lo para a equipe entregar.

Como conversar:
- Português do Brasil, tom simpático, acolhedor e natural, como um atendente de bairro atencioso. Mensagens curtas, como no WhatsApp. Evite listas e textos longos; no máximo 1 ou 2 emojis por mensagem, quando combinar.
- Chame o cliente pelo primeiro nome quando souber.
- Pergunte uma coisa de cada vez. Não repita perguntas sobre o que o cliente já respondeu.
- Para separar ideias em mensagens diferentes, deixe uma linha em branco entre elas (no máximo 3 mensagens por resposta).
- Se perguntarem se você é um robô ou uma pessoa, diga com naturalidade que é a atendente virtual da loja e que pode chamar alguém da equipe se o cliente preferir.

Cliente já cadastrado (o contexto diz "CLIENTE CADASTRADO"):
- Você já sabe quem é: NUNCA pergunte o nome, nem peça para ele se apresentar. Cumprimente pelo primeiro nome desde a primeira resposta, com carinho de quem conhece o cliente (ex.: "Oi, Maria! Tudo bem? Vai ser o P13 de sempre?").
- Não peça o endereço de novo. Antes de fechar o pedido, só confirme se a entrega é no endereço do cadastro, citando-o (ex.: "Entrego aí na Rua das Flores, 120, Centro, certo?"). Confirme uma única vez por conversa.
- Se ele disser que mudou de endereço, pergunte o novo e salve com salvar_dados_cliente. Se for só esta entrega em outro lugar, use endereco_alternativo, sem mudar o cadastro.
- Se o cadastro não tiver endereço, peça apenas o endereço (nunca o nome).

Cliente novo (o contexto diz "CLIENTE NOVO"):
- Antes de registrar o pedido, você precisa do nome e do endereço completo: rua, número, bairro e um ponto de referência. O telefone você já tem pela conversa, não pergunte.
- Assim que tiver os dados, salve com a ferramenta salvar_dados_cliente.

Pedido:
- Use só os produtos e preços do catálogo informado no contexto. Nunca invente produto, preço, promoção ou prazo.
- Antes de registrar, calcule a taxa de entrega com calcular_taxa_entrega (quando a regra depender da distância) e confirme com o cliente: itens, endereço de entrega, forma de pagamento (e troco, se for dinheiro), taxa e valor total.
- Só chame registrar_pedido depois que o cliente confirmar. Depois de registrar, agradeça e informe a previsão de entrega.
- Se não conseguir localizar o endereço, peça para o cliente mandar a localização pelo WhatsApp (clipe 📎 → Localização) e calcule de novo.

Chame um humano (ferramenta chamar_atendente) quando: o cliente pedir para falar com uma pessoa; houver reclamação, problema com entrega, vazamento ou cheiro de gás; pedirem fiado, desconto ou algo fora do catálogo; quiserem alterar ou cancelar um pedido já registrado; ou quando você não souber responder com segurança.
Se o cliente relatar cheiro de gás ou vazamento, antes de tudo oriente: não acender fogo nem interruptores, fechar o registro, abrir portas e janelas e sair do local; em emergência, ligar para os Bombeiros (193).

Se o cliente só estiver respondendo a uma mensagem de lembrete da loja, continue a conversa normalmente a partir dela.${settings.ai_instructions ? `\n\nInstruções da loja:\n${settings.ai_instructions}` : ''}`;
}

const TOOLS = [
  {
    name: 'salvar_dados_cliente',
    description: 'Salva ou atualiza o cadastro do cliente desta conversa (o telefone é preenchido automaticamente). Use quando o cliente informar ou corrigir nome ou endereço. Campos que não mudaram devem ser enviados como texto vazio "".',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cliente como ele se apresentou' },
        endereco: { type: 'string', description: 'Rua e número (com complemento, se houver)' },
        bairro: { type: 'string' },
        ponto_referencia: { type: 'string' },
      },
      required: ['nome', 'endereco', 'bairro', 'ponto_referencia'],
      additionalProperties: false,
    },
  },
  {
    name: 'calcular_taxa_entrega',
    description: 'Calcula a taxa de entrega para o endereço cadastrado do cliente (ou para a localização que ele enviou). Se o pedido for para outro endereço, informe-o em endereco_alternativo; senão envie "".',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { endereco_alternativo: { type: 'string' } },
      required: ['endereco_alternativo'],
      additionalProperties: false,
    },
  },
  {
    name: 'registrar_pedido',
    description: 'Registra o pedido para a equipe separar e entregar. Só use depois que o cliente confirmar itens, endereço, pagamento e valor total. A taxa de entrega é calculada e somada automaticamente.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: { produto_id: { type: 'integer' }, quantidade: { type: 'integer' } },
            required: ['produto_id', 'quantidade'],
            additionalProperties: false,
          },
        },
        forma_pagamento: { type: 'string', enum: Object.keys(PAYMENTS) },
        troco_para: { type: 'number', description: 'Valor da nota para troco, se pagar em dinheiro; 0 se não precisar' },
        endereco_alternativo: { type: 'string', description: 'Endereço de entrega diferente do cadastro; "" para usar o cadastrado' },
        observacoes: { type: 'string', description: 'Observações para o entregador; "" se não houver' },
        endereco_confirmado: { type: 'boolean', description: 'true se o cliente confirmou nesta conversa o endereço de entrega' },
      },
      required: ['itens', 'forma_pagamento', 'troco_para', 'endereco_alternativo', 'observacoes', 'endereco_confirmado'],
      additionalProperties: false,
    },
  },
  {
    name: 'chamar_atendente',
    description: 'Passa a conversa para uma pessoa da equipe e desliga a IA nesta conversa. Depois de chamar, avise o cliente com uma mensagem curta e gentil.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Resumo curto do motivo para a equipe' } },
      required: ['motivo'],
      additionalProperties: false,
    },
  },
];

// ---------- Contexto do momento (vai como mensagem de sistema no fim da conversa) ----------

const money = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

function deliveryRuleText(s) {
  if (s.delivery_fee_mode === 'gratis') return 'Entrega grátis.';
  if (s.delivery_fee_mode === 'fixa') return `Taxa de entrega fixa de ${money(s.delivery_fee_fixed)}.`;
  const parts = [`Grátis até ${s.delivery_free_km} km da loja`];
  parts.push(`acima disso ${money(s.delivery_fee_fixed)}${s.delivery_fee_per_km > 0 ? ` + ${money(s.delivery_fee_per_km)} por km excedente` : ''}`);
  if (s.delivery_max_km > 0) parts.push(`não entregamos acima de ${s.delivery_max_km} km`);
  return parts.join('; ') + '. Use calcular_taxa_entrega para saber o valor exato.';
}

function contextNote(ctx, customer, earlierStoreMessages) {
  const { db } = ctx;
  const s = ctx.settings();
  const now = new Date();
  const time = localTime(now);
  const open = time >= s.business_hours_start && time < s.business_hours_end;
  const products = db.prepare('SELECT id, name, price FROM products WHERE active = 1 ORDER BY id').all();
  const lines = [
    `Contexto atual (informação do sistema, não é mensagem do cliente):`,
    `- Agora: ${now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}, ${time}. Horário da loja: ${s.business_hours_start} às ${s.business_hours_end} (${open ? 'aberta agora' : 'FECHADA agora — pode anotar o pedido avisando que a entrega será no próximo horário de funcionamento'}).`,
    `- Previsão de entrega: ${s.delivery_eta}. Formas de pagamento: ${s.payment_methods}.`,
    `- Entrega: ${deliveryRuleText(s)}`,
    `- Catálogo (produto_id: nome — preço): ${products.map((p) => `${p.id}: ${p.name} — ${money(p.price)}`).join('; ')}.`,
  ];

  const orders = db.prepare(`SELECT o.id, o.date, o.status, o.total, o.delivery_fee,
      (SELECT GROUP_CONCAT(oi.quantity || 'x ' || p.name, ', ') FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) AS items
    FROM orders o WHERE o.customer_id = ? AND o.status != 'cancelado' ORDER BY o.date DESC, o.id DESC LIMIT 3`).all(customer.id);
  const confirmed = Boolean(customer.address) || orders.length > 0 || !String(customer.notes).includes(AUTO_NOTE);
  lines.push(`- Telefone do cliente: ${formatPhone(customer.phone)}.`);
  if (confirmed) {
    const addr = [customer.address, customer.neighborhood].filter(Boolean).join(', ');
    // Cadastro feito só com o telefone: o "nome" é o número.
    if (/\p{L}/u.test(customer.name)) lines.push(`- CLIENTE CADASTRADO: ${customer.name} (chame de "${customer.name.trim().split(/\s+/)[0]}"; não pergunte o nome).`);
    else lines.push('- CLIENTE CADASTRADO, mas sem nome no cadastro: pergunte só o nome e salve com salvar_dados_cliente.');
    lines.push(addr
      ? `- Endereço do cadastro: ${addr}${customer.reference ? ` (referência: ${customer.reference})` : ''}. Só confirme se a entrega continua sendo nele.${customer.latitude != null ? ' Localização no mapa já registrada.' : ''}`
      : '- O cadastro não tem endereço: peça apenas o endereço.');
  } else {
    lines.push(`- Cliente NOVO, ainda sem cadastro confirmado. Nome no perfil do WhatsApp: "${customer.name}" (pode não ser o nome real — confirme). Endereço: ${customer.address || 'não informado'}.${customer.latitude != null ? ' Já enviou a localização pelo WhatsApp.' : ''}`);
  }
  if (orders.length) {
    const st = { novo: 'aguardando saída', saiu: 'saiu para entrega', entregue: 'entregue' };
    lines.push(`- Últimos pedidos: ${orders.map((o) => `#${o.id} em ${o.date.split('-').reverse().join('/')}: ${o.items || '—'} (${money(o.total)}, ${st[o.status] || o.status})`).join('; ')}.`);
  }
  if (customer.do_not_contact) lines.push('- O cliente pediu para não receber lembretes (pode ser atendido normalmente se ele chamar).');
  if (earlierStoreMessages.length) {
    lines.push(`- Mensagens que a loja enviou antes desta conversa: ${earlierStoreMessages.map((m) => `"${m}"`).join(' / ')}`);
  }
  return lines.join('\n');
}

// Monta a conversa a partir do histórico salvo (só texto; a IA não guarda estado entre respostas).
function buildHistory(db, key) {
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
  const rows = db.prepare(`SELECT direction, body, status FROM messages WHERE phone_key = ? AND created_at >= ? AND status != 'failed'
    ORDER BY id DESC LIMIT ?`).all(key, since, HISTORY_LIMIT).reverse();
  const messages = [];
  const earlier = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    if (!messages.length && role === 'assistant') { earlier.push(r.body); continue; }
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content += '\n' + r.body;
    else messages.push({ role, content: r.body });
  }
  return { messages, earlier };
}

// ---------- Ferramentas (execução) ----------

async function runTool(ctx, name, input, state) {
  const { db } = ctx;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(state.customerId);
  const settings = ctx.settings();

  if (name === 'salvar_dados_cliente') {
    const nome = String(input.nome ?? '').trim();
    const sets = [];
    const args = [];
    if (nome) { sets.push('name = ?'); args.push(nome); }
    const addrChanged = String(input.endereco ?? '').trim() || String(input.bairro ?? '').trim();
    for (const [field, col] of [['endereco', 'address'], ['bairro', 'neighborhood'], ['ponto_referencia', 'reference']]) {
      const v = String(input[field] ?? '').trim();
      if (v) { sets.push(`${col} = ?`); args.push(v); }
    }
    // Endereço novo: a localização antiga (se veio do endereço) deixa de valer.
    if (addrChanged && customer.location_source !== 'whatsapp') sets.push("latitude = NULL, longitude = NULL, location_source = ''");
    if (String(customer.notes).includes(AUTO_NOTE)) {
      sets.push('notes = ?');
      args.push(String(customer.notes).replace(AUTO_NOTE, 'Cadastrado pela IA de atendimento'));
    }
    if (!sets.length) return { ok: false, error: 'Nenhum dado informado.' };
    db.prepare(`UPDATE customers SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, new Date().toISOString(), customer.id);
    const c = db.prepare('SELECT name, address, neighborhood, reference FROM customers WHERE id = ?').get(customer.id);
    ctx.broadcast('customers', { id: customer.id });
    return { ok: true, cadastro: c };
  }

  if (name === 'calcular_taxa_entrega') {
    const alt = String(input.endereco_alternativo ?? '').trim();
    const q = await quoteDelivery(ctx, customer, { address: alt || null });
    if (!q.ok) return q;
    state.lastQuote = { address: alt, ...q };
    if (q.outOfRange) return { ok: true, entrega_disponivel: false, motivo: q.rule, distancia_km: q.distance_km };
    return { ok: true, entrega_disponivel: true, taxa: q.fee, taxa_formatada: money(q.fee), regra: q.rule, distancia_km: q.distance_km };
  }

  if (name === 'registrar_pedido') {
    const alt = String(input.endereco_alternativo ?? '').trim();
    if (!customer.address) {
      return { ok: false, error: 'Cadastro incompleto: salve nome e endereço do cliente com salvar_dados_cliente antes de registrar o pedido.' };
    }
    if (!input.endereco_confirmado) {
      return { ok: false, error: `Confirme com o cliente o endereço de entrega antes de registrar: ${alt || [customer.address, customer.neighborhood].filter(Boolean).join(', ')}.` };
    }
    const recent = db.prepare(`SELECT id FROM orders WHERE customer_id = ? AND status = 'novo' AND source = 'whatsapp' AND created_at > ?`)
      .get(customer.id, new Date(Date.now() - 30 * 60000).toISOString());
    if (recent && !state.allowSecondOrder) {
      state.allowSecondOrder = true;
      return { ok: false, error: `Este cliente já tem o pedido #${recent.id} registrado há poucos minutos. Se for realmente um pedido NOVO e adicional, confirme com o cliente e chame registrar_pedido de novo; para alterar o pedido existente, use chamar_atendente.` };
    }
    const items = [];
    for (const it of input.itens || []) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(it.produto_id));
      if (!p) return { ok: false, error: `Produto ${it.produto_id} não existe no catálogo.` };
      items.push({ product: p, quantity: Math.max(1, Math.round(Number(it.quantidade) || 1)) });
    }
    if (!items.length) return { ok: false, error: 'O pedido não tem itens.' };

    let quote = state.lastQuote && state.lastQuote.address === alt ? state.lastQuote : null;
    if (!quote) {
      if (settings.delivery_fee_mode === 'por_distancia') {
        quote = await quoteDelivery(ctx, customer, { address: alt || null });
        if (!quote.ok) return quote;
      } else quote = { ok: true, ...feeForDistance(settings, null), distance_km: null };
    }
    if (quote.outOfRange) return { ok: false, error: `Endereço fora da área de entrega (${quote.rule}).` };

    const fee = quote.fee || 0;
    const subtotal = items.reduce((s, i) => s + i.quantity * i.product.price, 0);
    const notes = [
      'Pedido feito pela IA no WhatsApp',
      alt ? `ENTREGAR EM: ${alt}` : '',
      input.forma_pagamento === 'dinheiro' && input.troco_para > 0 ? `Troco para ${money(input.troco_para)}` : '',
      String(input.observacoes ?? '').trim(),
    ].filter(Boolean).join(' · ');
    db.exec('BEGIN');
    let orderId;
    try {
      ({ lastInsertRowid: orderId } = db.prepare(`INSERT INTO orders (customer_id, date, status, payment_method, total, delivery_fee, distance_km, notes, source, created_at)
        VALUES (?, ?, 'novo', ?, ?, ?, ?, ?, 'whatsapp', ?)`)
        .run(customer.id, localDate(), input.forma_pagamento, subtotal + fee, fee, quote.distance_km ?? null, notes, new Date().toISOString()));
      const ins = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
      for (const i of items) ins.run(Number(orderId), i.product.id, i.quantity, i.product.price);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    ctx.broadcast('orders', {});
    ctx.broadcast('reminders', {});
    return {
      ok: true, pedido: Number(orderId), itens: items.map((i) => `${i.quantity}x ${i.product.name}`),
      subtotal: money(subtotal), taxa_entrega: money(fee), total: money(subtotal + fee), previsao: settings.delivery_eta,
    };
  }

  if (name === 'chamar_atendente') {
    setChatState(db, state.key, { ai_enabled: 0, needs_human: 1, handoff_reason: String(input.motivo ?? '').slice(0, 300) });
    state.handedOff = true;
    ctx.broadcast('handoff', { phone_key: state.key, phone: customer.phone, name: customer.name, reason: input.motivo });
    return { ok: true, mensagem: 'A equipe foi avisada e vai assumir a conversa. Avise o cliente com uma mensagem curta.' };
  }

  return { ok: false, error: 'Ferramenta desconhecida' };
}

// ---------- Agente ----------

export function createAgent(ctx) {
  const timers = new Map();
  const running = new Set();
  const pending = new Set();
  let cachedClient = null;
  let cachedKey = null;

  function client() {
    if (ctx.aiClient) return ctx.aiClient; // usado nos testes
    const key = ctx.settings().ai_api_key || process.env.ANTHROPIC_API_KEY || '';
    if (!key) return null;
    if (key !== cachedKey) { cachedClient = new Anthropic({ apiKey: key }); cachedKey = key; }
    return cachedClient;
  }

  async function reply(state, text) {
    const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const bubbles = parts.length > 3 ? [...parts.slice(0, 2), parts.slice(2).join('\n\n')] : parts;
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, ctx.aiClient ? 0 : 1200));
      await sendMessage(ctx, { phone: state.phone, customerId: state.customerId, text: bubbles[i], sender: 'ia' });
    }
  }

  function flagProblem(key, reason) {
    setChatState(ctx.db, key, { needs_human: 1, handoff_reason: reason });
    ctx.broadcast('handoff', { phone_key: key, reason });
  }

  async function run(phone) {
    const { db } = ctx;
    const key = phoneKey(phone);
    if (!aiActiveFor(ctx, key)) return;
    const api = client();
    if (!api) { flagProblem(key, 'IA ligada, mas sem chave da API configurada'); return; }
    const customer = db.prepare('SELECT * FROM customers WHERE phone_key = ?').get(key);
    if (!customer) return;

    const { messages, earlier } = buildHistory(db, key);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return; // nada novo para responder
    const settings = ctx.settings();
    messages.push({ role: 'system', content: contextNote(ctx, customer, earlier) });

    const state = { key, phone: customer.phone, customerId: customer.id, handedOff: false, lastQuote: null };
    const texts = [];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await api.beta.messages.create({
          model: settings.ai_model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: settings.ai_effort },
          system: [{ type: 'text', text: systemPrompt(settings), cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages,
        });
        if (response.stop_reason === 'refusal') {
          await runTool(ctx, 'chamar_atendente', { motivo: 'A IA não pôde responder a esta mensagem' }, state);
          break;
        }
        for (const b of response.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !toolUses.length) break;

        messages.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const tu of toolUses) {
          let result;
          try {
            result = await runTool(ctx, tu.name, tu.input, state);
          } catch (err) {
            result = { ok: false, error: 'Erro interno: ' + err.message };
          }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result), is_error: result.ok === false });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      let reason = 'Erro na IA: ' + err.message;
      if (err instanceof Anthropic.AuthenticationError) reason = 'Chave da API da IA inválida';
      else if (err instanceof Anthropic.RateLimitError) reason = 'IA sobrecarregada (limite de uso); responda manualmente';
      console.error('IA de atendimento:', err.message);
      flagProblem(key, reason);
      return;
    }

    const text = texts.join('\n\n');
    if (text) await reply(state, text);
    else if (state.handedOff) await reply(state, settings.ai_handoff_message);
  }

  async function runSafely(phone) {
    const key = phoneKey(phone);
    if (running.has(key)) { pending.add(key); return; }
    running.add(key);
    try {
      await run(phone);
    } catch (err) {
      console.error('IA de atendimento:', err);
    } finally {
      running.delete(key);
      if (pending.delete(key)) schedule(phone, 0);
    }
  }

  // Espera alguns segundos: o cliente costuma mandar várias mensagens seguidas.
  function schedule(phone, delayMs = ctx.settings().ai_wait_seconds * 1000) {
    const key = phoneKey(phone);
    clearTimeout(timers.get(key));
    const t = setTimeout(() => { timers.delete(key); runSafely(phone); }, delayMs);
    t.unref?.();
    timers.set(key, t);
  }

  return { schedule, run: runSafely, client };
}

export { TOOLS, buildHistory };
