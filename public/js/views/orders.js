import { ORDER_STATUS, PAYMENTS, SOURCES, addDaysISO, api, attempt, confirmDialog, fmtDate, fmtMoney, fmtPhone, h, mount, today } from '../lib.js';
import { orderDialog } from '../dialogs.js';
import { on } from '../store.js';

const RANGES = {
  hoje: () => [today(), today()],
  ontem: () => [addDaysISO(today(), -1), addDaysISO(today(), -1)],
  semana: () => [addDaysISO(today(), -6), today()],
  mes: () => [today().slice(0, 8) + '01', today()],
  abertos: () => ['', ''],
};

export function render(container) {
  let range = sessionStorage.getItem('ordRange') || 'hoje';
  let status = '';
  let orders = [];

  async function load() {
    const [from, to] = RANGES[range]();
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (range === 'abertos') qs.set('status', 'abertos');
    else if (status) qs.set('status', status);
    orders = await api('/api/orders?' + qs);
    draw();
  }

  async function setStatus(o, next, btn) {
    await attempt(async () => { await api('/api/orders/' + o.id, { method: 'PUT', body: { status: next } }); load(); }, btn);
  }

  function draw() {
    const valid = orders.filter((o) => o.status !== 'cancelado');
    const total = valid.reduce((s, o) => s + o.total, 0);
    const byPay = {};
    for (const o of valid) byPay[o.payment_method] = (byPay[o.payment_method] || 0) + o.total;
    const units = {};
    for (const o of valid) for (const i of o.items) units[i.product_name] = (units[i.product_name] || 0) + i.quantity;

    mount(container,
      h('div', { class: 'page-head' },
        h('h1', {}, 'Pedidos'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => orderDialog({ onSaved: load }) }, '+ Novo pedido'))),
      h('div', { class: 'tabs' }, Object.entries({ hoje: 'Hoje', ontem: 'Ontem', semana: '7 dias', mes: 'Este mês', abertos: 'A entregar' })
        .map(([k, l]) => h('button', { class: k === range ? 'active' : '', onclick: () => { range = k; sessionStorage.setItem('ordRange', k); load(); } }, l))),
      range !== 'abertos' ? h('div', { class: 'toolbar' },
        h('select', { onchange: (e) => { status = e.target.value; load(); } },
          h('option', { value: '' }, 'Todas as situações'),
          Object.entries(ORDER_STATUS).map(([k, v]) => h('option', { value: k, selected: k === status }, v.label)))) : null,
      h('div', { class: 'grid kpis' },
        h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Total'), h('div', { class: 'value' }, fmtMoney(total)), h('div', { class: 'sub' }, `${valid.length} pedido(s)`)),
        h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Por pagamento'),
          h('div', { class: 'small', style: { marginTop: '4px' } }, Object.entries(byPay).map(([k, v]) => h('div', {}, `${PAYMENTS[k] || '—'}: ${fmtMoney(v)}`)))),
        h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Produtos'),
          h('div', { class: 'small', style: { marginTop: '4px' } }, Object.entries(units).map(([k, v]) => h('div', {}, `${v}× ${k}`))))),
      h('div', { class: 'card', style: { padding: 0 } }, orders.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ['Data', 'Cliente', 'Itens', 'Total', 'Pagamento', 'Situação', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, orders.map((o) => h('tr', {},
          h('td', { class: 'nowrap' }, fmtDate(o.date), h('div', { class: 'small muted' }, SOURCES[o.source] || o.source)),
          h('td', {}, h('a', { href: '#/clientes/' + o.customer_id }, h('strong', {}, o.customer_name)),
            h('div', { class: 'small muted' }, [o.address, o.neighborhood].filter(Boolean).join(', ') || fmtPhone(o.phone)),
            o.reference ? h('div', { class: 'small muted' }, 'Ref.: ' + o.reference) : null,
            o.notes ? h('div', { class: 'small' }, '📝 ' + o.notes) : null),
          h('td', {}, o.items.map((i) => h('div', { class: 'small' }, `${i.quantity}× ${i.product_name}`))),
          h('td', { class: 'nowrap' }, fmtMoney(o.total)),
          h('td', {}, h('select', {
            style: { width: 'auto', padding: '4px 6px' },
            onchange: (e) => attempt(() => api('/api/orders/' + o.id, { method: 'PUT', body: { payment_method: e.target.value } })),
          }, Object.entries(PAYMENTS).map(([k, v]) => h('option', { value: k, selected: k === o.payment_method }, v)))),
          h('td', {}, h('span', { class: 'badge ' + ORDER_STATUS[o.status].cls }, ORDER_STATUS[o.status].label)),
          h('td', {}, h('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } },
            o.status === 'novo' ? h('button', { class: 'btn sm', onclick: (e) => setStatus(o, 'saiu', e.currentTarget) }, '🚚 Saiu') : null,
            ['novo', 'saiu'].includes(o.status) ? h('button', { class: 'btn sm', onclick: (e) => setStatus(o, 'entregue', e.currentTarget) }, '✅ Entregue') : null,
            o.status !== 'cancelado' ? h('button', {
              class: 'btn sm ghost danger',
              onclick: async (e) => { const btn = e.currentTarget; if (await confirmDialog('Cancelar este pedido?', { ok: 'Cancelar pedido', danger: true })) setStatus(o, 'cancelado', btn); },
            }, 'Cancelar') : h('button', {
              class: 'btn sm ghost danger',
              onclick: async () => { if (await confirmDialog('Excluir o pedido definitivamente?', { ok: 'Excluir', danger: true })) attempt(async () => { await api('/api/orders/' + o.id, { method: 'DELETE' }); load(); }); },
            }, 'Excluir')))))))) : h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧾'), 'Nenhum pedido neste período.')));
  }

  const off = on('orders', load);
  load();
  return off;
}
