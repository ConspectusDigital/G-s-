import { STATUS, api, attempt, fmtDate, fmtPhone, h, initials, mount, relDays, toast, confirmDialog } from '../lib.js';
import { contactDialog, orderDialog, reminderDialog, snoozeDialog } from '../dialogs.js';
import { on } from '../store.js';

const TABS = [
  ['chamar', 'Chamar agora', 'Clientes cujo produto deve acabar nos próximos dias (ou já acabou).'],
  ['inativo', 'Reconquistar', 'Passaram bem do prazo sem comprar: provavelmente estão comprando de outro lugar.'],
  ['aguardando', 'Aguardando', 'Já foram contatados recentemente. Voltam para "Chamar" se não comprarem.'],
  ['adiado', 'Adiados', 'Pediram para ser lembrados mais tarde.'],
  ['em_dia', 'Em dia', 'Ainda têm produto. Ordenados por quem acaba primeiro.'],
  ['bloqueado', 'Não contatar', 'Pediram para não receber lembretes.'],
];

const SOURCE_LABEL = { historico: 'pelo histórico', padrao: 'padrão do produto', manual: 'definido manualmente' };

export function reminderCard(item, { refresh, selectable = false, selected = null, compact = false } = {}) {
  const pct = Math.min(100, Math.round((item.daysSince / item.cycle) * 100));
  const cls = item.late ? 'late' : item.daysToDue <= 3 ? 'soon' : '';
  const due = item.daysToDue < 0 ? `deve ter acabado ${relDays(item.daysToDue)}` : `deve acabar ${relDays(item.daysToDue)}`;
  const canCall = ['chamar', 'inativo', 'em_dia', 'adiado', 'aguardando'].includes(item.status);

  return h('div', { class: 'rem ' + cls + (compact ? ' compact' : '') },
    selectable
      ? h('input', { type: 'checkbox', checked: selected?.has(key(item)), disabled: !item.phone, onchange: (e) => (e.target.checked ? selected.add(key(item)) : selected.delete(key(item))) })
      : h('div', { class: 'avatar' }, initials(item.customer_name)),
    h('div', {},
      h('div', {}, h('a', { href: '#/clientes/' + item.customer_id, class: 'who' }, item.customer_name), ' ',
        h('span', { class: 'badge ' + STATUS[item.status].cls }, STATUS[item.status].label)),
      h('div', { class: 'meta' },
        h('span', {}, '🛒 ' + item.product_name + (item.last_qty > 1 ? ` (${item.last_qty} un.)` : '')),
        h('span', {}, `Última compra: ${fmtDate(item.last_date)} — há ${item.daysSince} dias`),
        h('span', {}, `Ciclo: ${item.cycle} dias (${SOURCE_LABEL[item.cycle_source]})`),
        item.phone ? h('span', {}, '📱 ' + fmtPhone(item.phone)) : h('span', { style: { color: 'var(--danger)' } }, 'sem telefone'),
        item.neighborhood ? h('span', {}, '📍 ' + item.neighborhood) : null),
      h('div', { class: 'meta' },
        h('strong', { style: { color: item.late ? 'var(--danger)' : 'inherit' } }, due + ` (${fmtDate(item.dueDate)})`),
        item.lastContact ? h('span', {}, `Último contato: ${fmtDate(item.lastContact.date)}${item.lastContact.snooze_until ? ' · lembrar em ' + fmtDate(item.lastContact.snooze_until) : ''}`) : null,
        item.attempts ? h('span', {}, `${item.attempts} tentativa(s) neste ciclo`) : null),
      h('div', { class: 'bar' }, h('i', { class: pct >= 100 ? 'full' : pct >= 80 ? 'mid' : '', style: { width: pct + '%' } }))),
    h('div', { class: 'actions' },
      canCall && item.phone ? h('button', { class: 'btn wa sm', onclick: () => reminderDialog(item, { onSent: refresh }) }, 'WhatsApp') : null,
      item.phone ? h('a', { class: 'btn sm', href: 'tel:+' + item.phone }, 'Ligar') : null,
      h('button', { class: 'btn sm', onclick: () => contactDialog(item, { onSaved: refresh }) }, 'Registrar'),
      canCall ? h('button', { class: 'btn sm', onclick: () => snoozeDialog(item, { onSaved: refresh }) }, 'Adiar') : null,
      h('button', { class: 'btn sm primary', onclick: () => orderDialog({ customer: { id: item.customer_id, name: item.customer_name, phone: item.phone, address: item.address, neighborhood: item.neighborhood }, source: 'lembrete', productId: item.product_id, onSaved: refresh }) }, 'Vendeu')));
}

const key = (i) => `${i.customer_id}:${i.product_id}`;

export function render(container) {
  let tab = sessionStorage.getItem('remTab') || 'chamar';
  let data = { items: [], counts: {}, queue: 0 };
  let q = '';
  const selected = new Set();

  async function load() {
    data = await api('/api/reminders');
    draw();
  }

  function draw() {
    const all = data.items.filter((i) => i.status === tab);
    const lower = q.toLowerCase();
    const items = q ? all.filter((i) => [i.customer_name, i.neighborhood, i.phone, i.address].some((v) => (v || '').toLowerCase().includes(lower))) : all;
    if (tab === 'em_dia') items.sort((a, b) => a.daysToDue - b.daysToDue);
    const bulk = tab === 'chamar' || tab === 'inativo';
    const desc = TABS.find((t) => t[0] === tab)[2];

    mount(container,
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Quem chamar'), h('div', { class: 'muted small' }, 'O sistema calcula quando o gás de cada cliente deve acabar, pelo histórico de compras.')),
        data.queue ? h('span', { class: 'badge info' }, `Enviando… ${data.queue} na fila`) : null),
      h('div', { class: 'tabs' }, TABS.map(([k, label]) => h('button', {
        class: k === tab ? 'active' : '',
        onclick: () => { tab = k; sessionStorage.setItem('remTab', k); selected.clear(); draw(); },
      }, label, data.counts[k] ? h('span', { class: 'badge' + (k === 'chamar' ? ' brand' : '') }, data.counts[k]) : null))),
      h('div', { class: 'toolbar' },
        h('input', { type: 'search', placeholder: 'Filtrar por nome, bairro, telefone…', value: q, oninput: (e) => { q = e.target.value; drawList(); } }),
        bulk && items.length ? h('button', { class: 'btn sm', onclick: () => { items.forEach((i) => i.phone && selected.add(key(i))); draw(); } }, 'Selecionar todos') : null,
        bulk && items.length ? h('button', { class: 'btn wa sm', onclick: sendBulk }, 'Enviar lembrete aos selecionados') : null),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, desc),
      h('div', { class: 'rem-list', id: 'rem-list' }));
    drawList();

    function drawList() {
      const list = container.querySelector('#rem-list');
      const shown = q ? all.filter((i) => [i.customer_name, i.neighborhood, i.phone, i.address].some((v) => (v || '').toLowerCase().includes(q.toLowerCase()))) : items;
      if (!shown.length) {
        mount(list, h('div', { class: 'card empty' }, h('div', { class: 'big' }, tab === 'chamar' ? '🎉' : '📭'),
          tab === 'chamar' ? 'Ninguém para chamar agora. Cadastre clientes com a data da última compra para o sistema começar a avisar.' : 'Nenhum cliente aqui.'));
        return;
      }
      mount(list, shown.map((i) => reminderCard(i, { refresh: load, selectable: bulk, selected })));
    }
  }

  async function sendBulk(e) {
    const items = data.items.filter((i) => selected.has(key(i)));
    if (!items.length) { toast('Selecione pelo menos um cliente', 'error'); return; }
    const ok = await confirmDialog(`Enviar lembrete por WhatsApp para ${items.length} cliente(s)? As mensagens saem uma de cada vez, com intervalo, para não parecer spam.`, { ok: 'Enviar' });
    if (!ok) return;
    await attempt(async () => {
      const r = await api('/api/reminders/send-bulk', { method: 'POST', body: { items: items.map((i) => ({ customer_id: i.customer_id, product_id: i.product_id })) } });
      toast(`${r.added} mensagem(ns) na fila de envio`);
      selected.clear();
      load();
    }, e.currentTarget);
  }

  const offs = [on('reminders', load), on('queue', (d) => { data.queue = d.pending; if (!d.pending) load(); })];
  load();
  return () => offs.forEach((off) => off());
}
