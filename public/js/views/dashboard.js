import { api, fmtDate, fmtMoney, h, mount } from '../lib.js';
import { orderDialog } from '../dialogs.js';
import { on } from '../store.js';
import { reminderCard } from './reminders.js';

function kpi(label, value, sub, { href, highlight } = {}) {
  return h(href ? 'a' : 'div', { class: 'card kpi' + (highlight ? ' highlight' : ''), href },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function chart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.revenue));
  return h('div', {},
    h('div', { class: 'chart' }, daily.map((d, i) => h('div', {
      class: 'col' + (i === daily.length - 1 ? ' today' : ''),
      style: { height: Math.max(1.5, (d.revenue / max) * 100) + '%' },
      title: `${fmtDate(d.date)}: ${d.orders} pedido(s) · ${fmtMoney(d.revenue)}`,
    }))),
    h('div', { class: 'chart-axis' }, h('span', {}, fmtDate(daily[0].date)), h('span', {}, 'hoje')));
}

export function render(container) {
  async function load() {
    const d = await api('/api/dashboard');
    const diff = d.prevMonth.revenue ? Math.round(((d.month.revenue - d.prevMonth.revenue) / d.prevMonth.revenue) * 100) : null;
    const conv = d.conversion.contacted ? Math.round((d.conversion.converted / d.conversion.contacted) * 100) : 0;
    mount(container,
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Painel'), h('div', { class: 'muted small' }, new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => orderDialog({ onSaved: load }) }, '+ Novo pedido'))),
      h('div', { class: 'grid kpis' },
        kpi('Chamar hoje', d.counts.chamar || 0, 'clientes com gás acabando', { href: '#/lembretes', highlight: true }),
        kpi('Vendas hoje', fmtMoney(d.today.revenue), `${d.today.orders} pedido(s)`, { href: '#/pedidos' }),
        kpi('Vendas no mês', fmtMoney(d.month.revenue),
          diff === null ? `${d.month.orders} pedido(s)` : `${d.month.orders} pedido(s) · ${diff >= 0 ? '+' : ''}${diff}% vs mês passado`),
        kpi('Vendas após lembrete', fmtMoney(d.recovered.revenue), `${d.recovered.orders} pedido(s) no mês · ${conv}% dos contatos compraram`),
        kpi('Entregas pendentes', d.openOrders, 'novos ou em rota', { href: '#/pedidos' }),
        kpi('Mensagens não lidas', d.unread, null, { href: '#/atendimento' })),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } },
            h('h2', { style: { margin: 0 } }, 'Para chamar agora'), h('a', { href: '#/lembretes' }, 'Ver todos →')),
          d.callList.length
            ? h('div', { class: 'rem-list' }, d.callList.map((i) => reminderCard(i, { refresh: load, compact: true })))
            : h('div', { class: 'empty' }, h('div', { class: 'big' }, '✅'), 'Nenhum cliente para chamar agora.')),
        h('div', {},
          h('div', { class: 'card' }, h('h2', {}, 'Faturamento — últimos 30 dias'), chart(d.daily)),
          h('div', { class: 'card' }, h('h2', {}, 'Carteira de clientes'),
            h('table', { class: 'list' }, h('tbody', {},
              h('tr', {}, h('td', {}, 'Clientes cadastrados'), h('td', { style: { textAlign: 'right' } }, h('strong', {}, d.customers))),
              h('tr', {}, h('td', {}, 'Vão precisar nos próximos dias'), h('td', { style: { textAlign: 'right' } }, h('strong', {}, d.upcoming))),
              h('tr', {}, h('td', {}, 'Aguardando resposta'), h('td', { style: { textAlign: 'right' } }, h('strong', {}, d.counts.aguardando || 0))),
              h('tr', {}, h('td', {}, h('a', { href: '#/lembretes' }, 'Sumidos (reconquistar)')), h('td', { style: { textAlign: 'right' } }, h('strong', {}, d.counts.inativo || 0)))))))));
  }
  const offs = ['orders', 'reminders'].map((e) => on(e, load));
  load();
  return () => offs.forEach((off) => off());
}
