import { STATUS, api, attempt, debounce, field, fmtDate, fmtPhone, fmtTime, h, initials, modal, mount, toast } from '../lib.js';
import { orderDialog } from '../dialogs.js';
import { loadTemplates, on, store } from '../store.js';

const STATUS_ICON = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠️', received: '' };
const SENDER_LABEL = { ia: '🤖 IA', lembrete: '🔔 Lembrete', automatico: '⚙️ Automática', celular: '📱 Celular da loja' };

function linkify(text) {
  const parts = String(text).split(/(https?:\/\/\S+)/g);
  return parts.map((p, i) => (i % 2 ? h('a', { href: p, target: '_blank', rel: 'noopener' }, p) : p));
}

function dayLabel(iso) {
  const d = new Date(iso);
  const t = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === t.toDateString()) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function convTime(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? fmtTime(iso) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function render(container, params) {
  let conversations = [];
  let current = params[0] || null; // telefone aberto
  let thread = null;
  let q = '';
  let provider = 'simulator';

  const shell = h('div', { class: 'chat-shell' });
  const listItems = h('div', { class: 'conv-items' });
  const chatPane = h('div', { class: 'chat' });
  const search = h('input', { type: 'search', placeholder: 'Buscar conversa…', oninput: debounce((e) => { q = e.target.value; loadList(); }) });
  const listHead = h('div', { class: 'head' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('h2', { style: { margin: 0 } }, 'Atendimento'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onclick: newConversation, title: 'Nova conversa' }, '+ Nova'),
        h('button', { class: 'btn sm hidden', id: 'sim-btn', onclick: simulate, title: 'Simular mensagem de cliente' }, 'Simular'))),
    search);
  shell.append(h('div', { class: 'conv-list' }, listHead, listItems), chatPane);
  mount(container, shell);

  api('/api/whatsapp/status').then((s) => {
    provider = s.provider;
    shell.querySelector('#sim-btn').classList.toggle('hidden', provider !== 'simulator');
  }).catch(() => {});

  async function loadList() {
    conversations = await api('/api/conversations' + (q ? '?q=' + encodeURIComponent(q) : ''));
    drawList();
  }

  function drawList() {
    if (!conversations.length) {
      mount(listItems, h('div', { class: 'empty small' }, 'Nenhuma conversa ainda. Quando um cliente mandar mensagem no WhatsApp, ela aparece aqui.'));
      return;
    }
    mount(listItems, conversations.map((c) => h('div', {
      class: 'conv' + (current && c.phone_key === thread?.key ? ' active' : ''),
      onclick: () => { location.hash = '#/atendimento/' + c.phone; },
    },
    h('div', { class: 'avatar' }, initials(c.customer_name || '#')),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'name' }, c.ai_active ? h('span', { title: 'IA atendendo' }, '🤖 ') : null, c.customer_name || fmtPhone(c.phone)),
      c.needs_human ? h('div', { class: 'small', style: { color: 'var(--danger)', fontWeight: 600 } }, '⚠️ Precisa de você') : null,
      h('div', { class: 'preview' }, (c.last_direction === 'out' ? (STATUS_ICON[c.last_status] || '') + ' ' : '') + c.last_body)),
    h('div', { class: 'right' }, h('span', {}, convTime(c.last_at)), c.unread ? h('span', { class: 'unread' }, c.unread) : null))));
  }

  async function openThread(phone) {
    current = phone;
    shell.classList.toggle('has-chat', Boolean(phone));
    if (!phone) {
      mount(chatPane, h('div', { class: 'chat-empty' }, h('div', {}, h('div', { style: { fontSize: '44px' } }, '💬'), 'Escolha uma conversa ao lado')));
      return;
    }
    const data = await api('/api/conversations/' + encodeURIComponent(phone));
    thread = data;
    drawThread(true);
    markRead();
    drawList();
  }

  function markRead() {
    if (!current) return;
    const conv = conversations.find((c) => c.phone_key === thread?.key);
    if (conv?.unread) {
      conv.unread = 0;
      api(`/api/conversations/${encodeURIComponent(current)}/read`, { method: 'POST' }).catch(() => {});
    }
  }

  function bubble(m) {
    return h('div', { class: `bubble ${m.direction}${m.status === 'failed' ? ' failed' : ''}`, 'data-id': m.id },
      linkify(m.body),
      m.error ? h('div', { class: 'err' }, 'Não enviada: ' + m.error) : null,
      h('div', { class: 'time' }, m.direction === 'out' && SENDER_LABEL[m.sender] ? SENDER_LABEL[m.sender] + ' · ' : '',
        fmtTime(m.created_at), m.direction === 'out' ? ' ' + (STATUS_ICON[m.status] || '') : ''));
  }

  function drawMessages(body) {
    let lastDay = '';
    const nodes = [];
    for (const m of thread.messages) {
      const day = dayLabel(m.created_at);
      if (day !== lastDay) { nodes.push(h('div', { class: 'day-sep' }, day)); lastDay = day; }
      nodes.push(bubble(m));
    }
    if (!nodes.length) nodes.push(h('div', { class: 'day-sep' }, 'Nenhuma mensagem ainda'));
    mount(body, nodes);
  }

  function drawThread(scroll) {
    const { customer, reminders, lastOrder, phone } = thread;
    const body = h('div', { class: 'chat-body' });
    const text = h('textarea', {
      placeholder: 'Digite uma mensagem…', title: 'Enter envia · Shift+Enter quebra linha', rows: 1,
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } },
      oninput: () => { text.style.height = 'auto'; text.style.height = Math.min(160, text.scrollHeight) + 'px'; },
    });
    const quickMenu = h('div', { class: 'quick-menu hidden' });
    const sendBtn = h('button', { class: 'btn wa', onclick: send }, 'Enviar');

    async function send() {
      const t = text.value.trim();
      if (!t) return;
      text.value = '';
      text.style.height = 'auto';
      await attempt(async () => {
        const msg = await api(`/api/conversations/${encodeURIComponent(phone)}/messages`, { method: 'POST', body: { text: t } });
        if (msg.status === 'failed') toast('Não foi possível enviar: ' + msg.error, 'error');
      }, sendBtn);
    }

    async function toggleQuick() {
      if (!quickMenu.classList.contains('hidden')) { quickMenu.classList.add('hidden'); return; }
      const templates = store.templates.length ? store.templates : await loadTemplates();
      const first = (customer?.name || '').split(' ')[0];
      const fill = (body) => body.replace(/\{nome\}/g, first).replace(/\{loja\}/g, window.STORE_NAME || '')
        .replace(/\{produto\}/g, reminders[0]?.product_name || 'gás').replace(/\{dias\}/g, String(reminders[0]?.daysSince ?? ''));
      mount(quickMenu, templates.map((t) => h('button', {
        onclick: () => { text.value = fill(t.body); quickMenu.classList.add('hidden'); text.focus(); text.dispatchEvent(new Event('input')); },
      }, h('strong', {}, t.name), h('small', {}, t.body))));
      quickMenu.classList.remove('hidden');
    }

    const strip = [];
    if (customer) {
      if (lastOrder) strip.push(h('span', {}, `Última compra: ${fmtDate(lastOrder.date)}`));
      for (const r of reminders) {
        strip.push(h('span', { class: 'badge ' + STATUS[r.status].cls }, `${r.product_name}: ${r.daysToDue < 0 ? 'deve ter acabado' : 'acaba em ' + r.daysToDue + ' dia(s)'}`));
      }
      if (customer.address) strip.push(h('span', { class: 'muted' }, '📍 ' + [customer.address, customer.neighborhood].filter(Boolean).join(', ')));
      if (customer.do_not_contact) strip.push(h('span', { class: 'badge' }, 'Não quer lembretes'));
    }

    const aiBox = h('div', { class: 'ai-box' });
    drawAi(aiBox);

    mount(chatPane,
      h('div', { class: 'chat-head' },
        h('button', { class: 'btn sm ghost mobile-only', onclick: () => { location.hash = '#/atendimento'; } }, '←'),
        h('div', { class: 'avatar' }, initials(customer?.name || '#')),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, customer ? h('a', { href: '#/clientes/' + customer.id, style: { color: 'inherit' } }, customer.name) : fmtPhone(phone)),
          h('div', { class: 'small muted' }, fmtPhone(phone))),
        h('button', {
          class: 'btn primary sm',
          onclick: () => orderDialog({ customer, source: 'whatsapp', onSaved: () => openThread(current) }),
        }, '+ Pedido')),
      aiBox,
      strip.length ? h('div', { class: 'chat-strip' }, strip) : null,
      body,
      h('div', { class: 'chat-input' },
        h('div', { class: 'quick' }, h('button', { class: 'btn', title: 'Respostas prontas', onclick: toggleQuick }, '⚡'), quickMenu),
        text, sendBtn));
    drawMessages(body);
    if (scroll) body.scrollTop = body.scrollHeight;
    if (window.innerWidth > 860) text.focus();
  }

  // Faixa que mostra quem está atendendo (IA ou pessoa) e permite trocar.
  function drawAi(box = chatPane.querySelector('.ai-box')) {
    if (!box || !thread) return;
    const { ai, phone } = thread;
    const toggle = (enabled) => (e) => attempt(async () => {
      await api(`/api/conversations/${encodeURIComponent(phone)}/ai`, { method: 'POST', body: { enabled } });
      await refreshAi();
      toast(enabled ? 'A IA voltou a atender esta conversa' : 'Você assumiu a conversa. A IA não vai responder aqui.');
    }, e.currentTarget);
    const parts = [];
    if (ai.needs_human) {
      parts.push(h('div', { class: 'ai-alert' }, h('strong', {}, '⚠️ Precisa de atendimento humano' + (ai.reason ? ':' : '')), ai.reason || '',
        h('button', {
          class: 'btn sm', style: { marginLeft: 'auto' },
          onclick: (e) => attempt(async () => { await api(`/api/conversations/${encodeURIComponent(phone)}/resolve`, { method: 'POST' }); await refreshAi(); }, e.currentTarget),
        }, 'Resolvido')));
    }
    if (ai.global) {
      parts.push(ai.active
        ? h('div', { class: 'ai-bar on' }, h('span', {}, '🤖 A IA está atendendo esta conversa'),
          h('button', { class: 'btn sm', onclick: toggle(false) }, '✋ Assumir conversa'))
        : h('div', { class: 'ai-bar off' }, h('span', {}, '👤 Atendimento humano — a IA está desligada aqui'),
          h('button', { class: 'btn sm', onclick: toggle(true) }, '🤖 Devolver para a IA')));
    }
    mount(box, parts);
  }

  async function refreshAi() {
    if (!current) return;
    const data = await api('/api/conversations/' + encodeURIComponent(current));
    if (thread && data.key === thread.key) {
      thread.ai = data.ai;
      thread.customer = data.customer;
      drawAi();
    }
    loadList();
  }

  function onMessage(m) {
    if (thread && m.phone_key === thread.key) {
      const i = thread.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) thread.messages[i] = m;
      else thread.messages.push(m);
      const body = chatPane.querySelector('.chat-body');
      const nearBottom = body && body.scrollHeight - body.scrollTop - body.clientHeight < 120;
      if (body) drawMessages(body);
      if (body && (nearBottom || m.direction === 'out')) body.scrollTop = body.scrollHeight;
      if (m.direction === 'in' && document.visibilityState === 'visible') {
        api(`/api/conversations/${encodeURIComponent(current)}/read`, { method: 'POST' }).catch(() => {});
      }
    }
    loadList();
  }

  function newConversation() {
    const phone = h('input', { inputmode: 'tel', placeholder: '(11) 98765-4321' });
    const m = modal({
      title: 'Nova conversa',
      body: field('Número do WhatsApp (com DDD)', phone),
      footer: [h('button', {
        class: 'btn primary',
        onclick: () => {
          let d = phone.value.replace(/\D/g, '');
          if (d.length === 10 || d.length === 11) d = '55' + d;
          if (d.length < 12) { toast('Número inválido', 'error'); return; }
          m.close();
          location.hash = '#/atendimento/' + d;
        },
      }, 'Abrir')],
    });
  }

  function simulate() {
    const phone = h('input', { inputmode: 'tel', value: thread?.phone ? fmtPhone(thread.phone) : '', placeholder: '(11) 98765-4321' });
    const name = h('input', { placeholder: 'Nome no WhatsApp (opcional)' });
    const text = h('textarea', { rows: 3 }, 'Oi, quero um gás');
    const coords = h('input', { placeholder: 'ex.: -23.5505, -46.6333 (opcional)' });
    const m = modal({
      title: 'Simular mensagem de cliente',
      body: h('div', {}, h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Modo de teste: finge que um cliente mandou mensagem, para você conhecer o sistema antes de conectar o WhatsApp de verdade.'),
        field('Telefone', phone), field('Nome', name), field('Mensagem', text),
        field('…ou enviar uma localização', coords, 'Se preencher, simula o cliente mandando a localização pelo WhatsApp.')),
      footer: [h('button', {
        class: 'btn primary',
        onclick: (e) => attempt(async () => {
          const [lat, lng] = coords.value.split(',').map((v) => Number(v.trim()));
          const loc = coords.value.trim() && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
          await api('/api/whatsapp/simulate', { method: 'POST', body: { phone: phone.value, name: name.value, text: text.value, ...loc } });
          m.close();
        }, e.currentTarget),
      }, 'Simular')],
    });
  }

  const offs = [on('message', onMessage), on('read', () => loadList()),
    on('handoff', (d) => { if (thread && d.phone_key === thread.key) refreshAi(); else loadList(); })];
  loadList().then(() => openThread(current));
  return {
    cleanup: () => offs.forEach((off) => off()),
    // Trocar de conversa sem recriar a tela inteira.
    update: (p) => openThread(p[0] || null),
  };
}
