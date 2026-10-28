import {
  CHANNELS, CONTACT_RESULTS, ORDER_STATUS, STATUS, api, attempt, confirmDialog, debounce, field, fmtDate, fmtDateTime, fmtMoney, fmtPhone,
  h, modal, mount, toast, today,
} from '../lib.js';
import { orderDialog } from '../dialogs.js';
import { loadProducts, store } from '../store.js';
import { reminderCard } from './reminders.js';

function customerForm(c = {}, { withLastPurchase = false } = {}) {
  const products = store.products.filter((p) => p.active && p.cycle_days);
  return h('form', { onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'form-grid' },
      field('Nome *', h('input', { name: 'name', value: c.name || '', required: true })),
      field('Telefone / WhatsApp', h('input', { name: 'phone', inputmode: 'tel', value: c.phone ? fmtPhone(c.phone) : '', placeholder: '(11) 98765-4321' })),
      h('div', { class: 'full' }, field('Endereço', h('input', { name: 'address', value: c.address || '', placeholder: 'Rua, número, complemento' }))),
      field('Bairro', h('input', { name: 'neighborhood', value: c.neighborhood || '' })),
      field('Ponto de referência', h('input', { name: 'reference', value: c.reference || '' })),
      h('div', { class: 'full' }, field('Observações', h('textarea', { name: 'notes', rows: 2 }, c.notes || '')))),
    withLastPurchase ? h('div', { class: 'card', style: { background: 'var(--brand-soft)', borderColor: '#f7c6a5', marginBottom: '12px' } },
      h('h3', {}, 'Última compra (opcional)'),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Se for um cliente antigo, informe quando ele comprou pela última vez. Assim o sistema já sabe quando avisar para chamar.'),
      h('div', { class: 'form-grid' },
        field('Data', h('input', { type: 'date', name: 'lp_date', max: today() })),
        field('Produto', h('select', { name: 'lp_product' }, products.map((p) => h('option', { value: p.id }, p.name)))))) : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'do_not_contact', checked: Boolean(c.do_not_contact) }), 'Não enviar lembretes para este cliente'));
}

function readCustomerForm(form) {
  const v = Object.fromEntries(new FormData(form));
  const body = {
    name: v.name, phone: v.phone, address: v.address, neighborhood: v.neighborhood, reference: v.reference, notes: v.notes,
    do_not_contact: form.querySelector('[name=do_not_contact]').checked,
  };
  if (v.lp_date) body.last_purchase = { date: v.lp_date, product_id: Number(v.lp_product) };
  return body;
}

export async function newCustomerDialog(onSaved) {
  if (!store.products.length) await loadProducts();
  const form = customerForm({}, { withLastPurchase: true });
  const save = h('button', {
    class: 'btn primary',
    onclick: () => attempt(async () => {
      const c = await api('/api/customers', { method: 'POST', body: readCustomerForm(form) });
      toast('Cliente cadastrado');
      m.close();
      onSaved?.(c);
    }, save),
  }, 'Salvar');
  const m = modal({ title: 'Novo cliente', body: form, wide: true, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
}

function importDialog(onDone) {
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv' });
  const text = h('textarea', { rows: 8, placeholder: 'nome;telefone;endereco;bairro;ultima_compra;produto\nMaria Silva;(11) 98765-4321;Rua A, 10;Centro;15/09/2026;P13' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    // Planilhas salvas pelo Excel no Brasil costumam vir em Latin-1.
    let s = new TextDecoder('utf-8').decode(buf);
    if (s.includes('�')) s = new TextDecoder('windows-1252').decode(buf);
    text.value = s;
  });
  const run = h('button', {
    class: 'btn primary',
    onclick: () => attempt(async () => {
      const r = await api('/api/customers/import', { method: 'POST', body: { csv: text.value } });
      m.close();
      modal({
        title: 'Importação concluída',
        body: h('div', {},
          h('p', {}, `✅ ${r.created} cliente(s) novo(s), ${r.updated} atualizado(s), ${r.skipped} linha(s) ignorada(s).`),
          r.errors.length ? h('div', { class: 'small' }, h('strong', {}, 'Avisos:'), r.errors.map((e) => h('div', {}, e))) : null),
      });
      onDone?.();
    }, run),
  }, 'Importar');
  const m = modal({
    title: 'Importar clientes de planilha',
    wide: true,
    body: h('div', {},
      h('p', { class: 'small', style: { marginTop: 0 } },
        'No Excel ou Google Planilhas, salve como ', h('strong', {}, 'CSV'), '. A primeira linha deve ter os nomes das colunas. Colunas aceitas: ',
        h('code', {}, 'nome, telefone, endereco, bairro, referencia, observacoes, ultima_compra, produto, quantidade'),
        '. Só "nome" é obrigatória. Clientes com o mesmo telefone são atualizados, não duplicados.'),
      field('Arquivo CSV', fileInput),
      field('…ou cole o conteúdo aqui', text)),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), run],
  });
}

export function render(container, params) {
  if (params[0]) return renderDetail(container, Number(params[0]));
  let q = sessionStorage.getItem('custQ') || '';
  let offset = 0;
  const PAGE = 50;

  async function load() {
    const { rows, total } = await api(`/api/customers?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}`);
    const today0 = today();
    const tbody = container.querySelector('tbody');
    const pager = container.querySelector('#pager');
    mount(tbody, rows.length ? rows.map((c) => {
      const days = c.last_order ? Math.round((Date.parse(today0) - Date.parse(c.last_order)) / 86400000) : null;
      return h('tr', { class: 'clickable', onclick: () => { location.hash = '#/clientes/' + c.id; } },
        h('td', {}, h('strong', {}, c.name), c.do_not_contact ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'não contatar') : null),
        h('td', { class: 'nowrap' }, fmtPhone(c.phone) || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'hide-mobile' }, [c.address, c.neighborhood].filter(Boolean).join(', ')),
        h('td', { class: 'nowrap' }, c.last_order ? `${fmtDate(c.last_order)} (${days}d)` : h('span', { class: 'muted' }, 'nunca')),
        h('td', { class: 'hide-mobile' }, c.order_count));
    }) : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.')));
    mount(pager, total > PAGE ? [
      h('button', { class: 'btn sm', disabled: offset === 0, onclick: () => { offset -= PAGE; load(); } }, '← Anterior'),
      h('span', { class: 'small muted' }, `${offset + 1}–${Math.min(total, offset + PAGE)} de ${total}`),
      h('button', { class: 'btn sm', disabled: offset + PAGE >= total, onclick: () => { offset += PAGE; load(); } }, 'Próxima →'),
    ] : h('span', { class: 'small muted' }, `${total} cliente(s)`));
  }

  mount(container,
    h('div', { class: 'page-head' },
      h('h1', {}, 'Clientes'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '/api/customers/export.csv' }, 'Exportar'),
        h('button', { class: 'btn', onclick: () => importDialog(load) }, 'Importar planilha'),
        h('button', { class: 'btn primary', onclick: () => newCustomerDialog((c) => { location.hash = '#/clientes/' + c.id; }) }, '+ Novo cliente'))),
    h('div', { class: 'toolbar' }, h('input', {
      type: 'search', placeholder: 'Buscar por nome, telefone, endereço ou bairro…', value: q,
      oninput: debounce((e) => { q = e.target.value; sessionStorage.setItem('custQ', q); offset = 0; load(); }),
    })),
    h('div', { class: 'card', style: { padding: 0 } }, h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Nome'), h('th', {}, 'Telefone'), h('th', { class: 'hide-mobile' }, 'Endereço'), h('th', {}, 'Última compra'), h('th', { class: 'hide-mobile' }, 'Pedidos'))),
      h('tbody')))),
    h('div', { id: 'pager', class: 'toolbar', style: { marginTop: '12px', justifyContent: 'center' } }));
  load();
}

function renderDetail(container, id) {
  async function load() {
    if (!store.products.length) await loadProducts();
    const d = await api('/api/customers/' + id);
    const c = d.customer;
    const tracked = store.products.filter((p) => p.cycle_days);

    mount(container,
      h('div', { class: 'page-head' },
        h('div', {}, h('a', { href: '#/clientes', class: 'small' }, '← Clientes'), h('h1', {}, c.name),
          h('div', { class: 'muted small' }, [fmtPhone(c.phone), c.address, c.neighborhood].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' },
          c.phone ? h('a', { class: 'btn wa', href: '#/atendimento/' + c.phone }, 'Conversa') : null,
          c.phone ? h('a', { class: 'btn', href: 'tel:+' + c.phone }, 'Ligar') : null,
          h('button', { class: 'btn primary', onclick: () => orderDialog({ customer: c, onSaved: load }) }, '+ Pedido'))),
      h('div', { class: 'grid two' },
        h('div', {},
          h('div', { class: 'card' }, h('h2', {}, 'Previsão de recompra'),
            d.reminders.length ? h('div', { class: 'rem-list' }, d.reminders.map((r) => reminderCard(r, { refresh: load, compact: true })))
              : h('p', { class: 'muted' }, 'Ainda sem compras registradas. Registre um pedido (ou a última compra) para o sistema calcular quando chamar.')),
          h('div', { class: 'card' }, h('h2', {}, `Pedidos (${d.stats.orders} · ${fmtMoney(d.stats.revenue)})`),
            d.orders.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' }, h('tbody', {}, d.orders.map((o) => h('tr', {},
              h('td', { class: 'nowrap' }, fmtDate(o.date)),
              h('td', {}, o.items.map((i) => h('div', { class: 'small' }, `${i.quantity}× ${i.product_name}`))),
              h('td', { class: 'nowrap' }, o.historical ? h('span', { class: 'muted small' }, 'registro anterior') : fmtMoney(o.total)),
              h('td', {}, h('span', { class: 'badge ' + ORDER_STATUS[o.status].cls }, ORDER_STATUS[o.status].label)),
              h('td', {}, o.historical ? h('button', {
                class: 'btn sm ghost danger',
                onclick: async () => { if (await confirmDialog('Remover este registro de compra?', { ok: 'Remover', danger: true })) attempt(async () => { await api('/api/orders/' + o.id, { method: 'DELETE' }); load(); }); },
              }, '✕') : null))))))
              : h('p', { class: 'muted' }, 'Nenhum pedido.'),
            h('button', { class: 'btn sm', onclick: () => lastPurchaseDialog(c, load) }, '+ Registrar compra antiga')),
          h('div', { class: 'card' }, h('h2', {}, 'Histórico de contatos'),
            d.contacts.length ? h('div', { class: 'timeline' }, d.contacts.map((ct) => h('div', { class: 'item' },
              h('div', { class: 'when' }, fmtDateTime(ct.created_at)),
              h('div', {}, h('strong', {}, CHANNELS[ct.channel] || ct.channel), ' — ', CONTACT_RESULTS[ct.result] || ct.result,
                ct.snooze_until ? ` (lembrar em ${fmtDate(ct.snooze_until)})` : '',
                ct.product_name ? h('span', { class: 'muted small' }, ' · ' + ct.product_name) : null,
                ct.user_name ? h('span', { class: 'muted small' }, ' · por ' + ct.user_name) : null,
                ct.notes ? h('div', { class: 'small muted' }, ct.notes) : null))))
              : h('p', { class: 'muted' }, 'Nenhum contato registrado.'))),
        h('div', {},
          h('div', { class: 'card' }, h('h2', {}, 'Dados do cliente'), (() => {
            const form = customerForm(c);
            const save = h('button', {
              class: 'btn primary',
              onclick: () => attempt(async () => { await api('/api/customers/' + id, { method: 'PUT', body: readCustomerForm(form) }); toast('Salvo'); load(); }, save),
            }, 'Salvar alterações');
            return h('div', {}, form, h('div', { class: 'btn-row', style: { justifyContent: 'space-between' } }, save,
              h('button', {
                class: 'btn ghost danger',
                onclick: async () => {
                  if (await confirmDialog(`Excluir ${c.name} e todo o histórico de pedidos? Isso não pode ser desfeito.`, { ok: 'Excluir', danger: true })) {
                    attempt(async () => { await api('/api/customers/' + id, { method: 'DELETE' }); location.hash = '#/clientes'; });
                  }
                },
              }, 'Excluir cliente')));
          })()),
          h('div', { class: 'card' }, h('h2', {}, 'Ciclo de consumo'),
            h('p', { class: 'small muted', style: { marginTop: 0 } }, 'O sistema aprende sozinho com o histórico. Se você sabe que esse cliente troca o gás num prazo diferente, defina aqui (em dias por unidade).'),
            tracked.map((p) => {
              const manual = d.manual.find((m) => m.product_id === p.id);
              const r = d.reminders.find((x) => x.product_id === p.id);
              const input = h('input', { type: 'number', min: 3, max: 365, value: manual?.days || '', placeholder: String(r?.unit_cycle || p.cycle_days), style: { width: '90px' } });
              return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
                h('div', { style: { flex: 1 } }, p.name, h('div', { class: 'small muted' }, r ? `Calculado: ${r.unit_cycle} dias` : `Padrão: ${p.cycle_days} dias`)),
                input,
                h('button', {
                  class: 'btn sm',
                  onclick: (e) => attempt(async () => { await api(`/api/customers/${id}/cycles/${p.id}`, { method: 'PUT', body: { days: input.value } }); toast('Ciclo atualizado'); load(); }, e.currentTarget),
                }, 'Salvar'));
            })))));
  }
  load().catch((err) => mount(container, h('div', { class: 'card empty' }, err.message)));
}

function lastPurchaseDialog(c, onSaved) {
  const products = store.products.filter((p) => p.active);
  const form = h('form', { onsubmit: (e) => e.preventDefault() },
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Use para registrar compras feitas antes de usar o sistema (não entram no faturamento).'),
    h('div', { class: 'form-grid' },
      field('Data', h('input', { type: 'date', name: 'date', max: today(), required: true })),
      field('Produto', h('select', { name: 'product_id' }, products.map((p) => h('option', { value: p.id }, p.name)))),
      field('Quantidade', h('input', { type: 'number', name: 'quantity', min: 1, value: 1 }))));
  const save = h('button', {
    class: 'btn primary',
    onclick: () => attempt(async () => {
      const v = Object.fromEntries(new FormData(form));
      if (!v.date) throw new Error('Informe a data');
      await api('/api/orders', {
        method: 'POST',
        body: { customer_id: c.id, date: v.date, status: 'entregue', source: 'historico', items: [{ product_id: Number(v.product_id), quantity: Number(v.quantity), unit_price: 0 }] },
      });
      m.close();
      onSaved();
    }, save),
  }, 'Salvar');
  const m = modal({ title: 'Registrar compra antiga', body: form, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
}
