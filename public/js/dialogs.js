// Janelas usadas em várias telas: novo pedido, enviar lembrete, registrar contato.
import {
  CHANNELS, CONTACT_RESULTS, PAYMENTS, SOURCES, api, attempt, debounce, field, fmtDate, fmtMoney, fmtPhone, h, modal, toast, today,
} from './lib.js';
import { loadProducts, loadTemplates, store } from './store.js';

// ---------- Novo pedido ----------
export async function orderDialog({ customer = null, source = 'balcao', productId = null, onSaved } = {}) {
  const products = (store.products.length ? store.products : await loadProducts()).filter((p) => p.active);
  let selected = customer;
  const items = [];

  const customerBox = h('div');
  const newCustomerForm = h('div', { class: 'form-grid hidden' },
    field('Nome', h('input', { name: 'nc_name' })),
    field('Telefone / WhatsApp', h('input', { name: 'nc_phone', inputmode: 'tel', placeholder: '(11) 98765-4321' })),
    h('div', { class: 'full' }, field('Endereço', h('input', { name: 'nc_address' }))),
    field('Bairro', h('input', { name: 'nc_neighborhood' })),
    field('Ponto de referência', h('input', { name: 'nc_reference' })));

  function renderCustomer() {
    if (selected) {
      customerBox.replaceChildren(h('div', { class: 'card', style: { padding: '10px 12px', marginBottom: '12px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
          h('div', {},
            h('strong', {}, selected.name),
            h('div', { class: 'small muted' }, [fmtPhone(selected.phone), selected.address, selected.neighborhood].filter(Boolean).join(' · '))),
          customer ? null : h('button', { class: 'btn sm ghost', onclick: () => { selected = null; renderCustomer(); } }, 'Trocar'))));
      newCustomerForm.classList.add('hidden');
      return;
    }
    const results = h('div', { class: 'suggest hidden' });
    const search = h('input', {
      type: 'search', placeholder: 'Buscar cliente por nome, telefone ou endereço…',
      oninput: debounce(async () => {
        const q = search.value.trim();
        if (q.length < 2) { results.classList.add('hidden'); return; }
        const { rows } = await api('/api/customers?limit=8&q=' + encodeURIComponent(q));
        results.replaceChildren(...rows.map((c) => h('div', { onclick: () => { selected = c; renderCustomer(); } },
          h('strong', {}, c.name), ' ', h('span', { class: 'small muted' }, [fmtPhone(c.phone), c.address].filter(Boolean).join(' · ')))),
        h('div', { onclick: () => { newCustomerForm.classList.remove('hidden'); newCustomerForm.querySelector('[name=nc_name]').value = q; results.classList.add('hidden'); } },
          h('strong', {}, '+ Cadastrar novo cliente "' + q + '"')));
        results.classList.remove('hidden');
      }),
    });
    customerBox.replaceChildren(field('Cliente', h('div', {}, search, results)));
  }

  const itemsBody = h('tbody');
  const totalEl = h('div', { class: 'total-line' });
  const feeInput = h('input', { type: 'number', step: '0.01', min: '0', value: 0, name: 'delivery_fee', style: { width: '100px' }, oninput: () => recalc() });
  function recalc() {
    const fee = Number(feeInput.value) || 0;
    totalEl.textContent = 'Total: ' + fmtMoney(items.reduce((s, i) => s + i.quantity * i.unit_price, 0) + fee);
  }
  function addItem(pid) {
    const p = products.find((x) => x.id === pid) || products[0];
    if (!p) return;
    const item = { product_id: p.id, quantity: 1, unit_price: p.price };
    items.push(item);
    const price = h('input', { type: 'number', step: '0.01', min: '0', value: item.unit_price, style: { width: '100px' }, oninput: () => { item.unit_price = Number(price.value) || 0; recalc(); } });
    const row = h('tr', {},
      h('td', {}, h('select', {
        onchange: (e) => {
          item.product_id = Number(e.target.value);
          item.unit_price = products.find((x) => x.id === item.product_id).price;
          price.value = item.unit_price; recalc();
        },
      }, products.map((x) => h('option', { value: x.id, selected: x.id === item.product_id }, x.name)))),
      h('td', {}, h('input', { type: 'number', min: '1', value: 1, style: { width: '64px' }, oninput: (e) => { item.quantity = Math.max(1, Number(e.target.value) || 1); recalc(); } })),
      h('td', {}, price),
      h('td', {}, h('button', { class: 'btn sm ghost', title: 'Remover', onclick: () => { items.splice(items.indexOf(item), 1); row.remove(); recalc(); } }, '✕')));
    itemsBody.append(row);
    recalc();
  }

  const form = h('form', { onsubmit: (e) => e.preventDefault() },
    customerBox, newCustomerForm,
    h('table', { class: 'items-table', style: { width: '100%' } },
      h('thead', {}, h('tr', {}, h('th', { class: 'small muted', style: { textAlign: 'left' } }, 'Produto'), h('th', { class: 'small muted' }, 'Qtd'), h('th', { class: 'small muted' }, 'Preço un.'), h('th'))),
      itemsBody),
    h('button', { type: 'button', class: 'btn sm', onclick: () => addItem(), style: { marginTop: '6px' } }, '+ Produto'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', marginTop: '8px' } },
      h('span', { class: 'small' }, 'Taxa de entrega (R$)'), feeInput),
    totalEl,
    h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      field('Pagamento', h('select', { name: 'payment_method' }, Object.entries(PAYMENTS).map(([k, v]) => h('option', { value: k }, v)))),
      field('Situação', h('select', { name: 'status' },
        h('option', { value: 'novo' }, 'Novo (a entregar)'), h('option', { value: 'saiu' }, 'Saiu para entrega'), h('option', { value: 'entregue' }, 'Já entregue'))),
      field('Data', h('input', { type: 'date', name: 'date', value: today(), max: today() })),
      field('Origem', h('select', { name: 'source' }, Object.entries(SOURCES).filter(([k]) => k !== 'historico').map(([k, v]) => h('option', { value: k, selected: k === source }, v)))),
      h('div', { class: 'full' }, field('Observações', h('input', { name: 'notes', placeholder: 'Ex.: troco para R$ 200, portão azul…' })))));

  renderCustomer();
  addItem(productId || products.find((p) => p.cycle_days)?.id);

  const save = h('button', {
    class: 'btn primary',
    onclick: () => attempt(async () => {
      const v = Object.fromEntries(new FormData(form));
      const body = { items, delivery_fee: Number(v.delivery_fee) || 0, payment_method: v.payment_method, status: v.status, date: v.date, source: v.source, notes: v.notes };
      if (selected) body.customer_id = selected.id;
      else body.new_customer = { name: v.nc_name, phone: v.nc_phone, address: v.nc_address, neighborhood: v.nc_neighborhood, reference: v.nc_reference };
      const order = await api('/api/orders', { method: 'POST', body });
      toast('Pedido registrado!');
      m.close();
      onSaved?.(order);
    }, save),
  }, 'Salvar pedido');
  const m = modal({ title: 'Novo pedido', body: form, wide: true, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
}

// ---------- Enviar lembrete por WhatsApp ----------
export async function reminderDialog(item, { onSent } = {}) {
  const templates = (store.templates.length ? store.templates : await loadTemplates())
    .filter((t) => t.kind === 'lembrete' || t.kind === 'reconquista');
  const text = h('textarea', { rows: 8 });
  const select = h('select', {
    onchange: () => preview(select.value),
  }, templates.map((t) => h('option', { value: t.id }, t.name)));

  async function preview(templateId) {
    const p = await api(`/api/reminders/preview?customer_id=${item.customer_id}&product_id=${item.product_id}${templateId ? '&template_id=' + templateId : ''}`);
    text.value = p.text;
    if (p.template_id) select.value = p.template_id;
  }
  await attempt(() => preview());

  const send = h('button', {
    class: 'btn wa',
    onclick: () => attempt(async () => {
      await api('/api/reminders/send', { method: 'POST', body: { customer_id: item.customer_id, product_id: item.product_id, text: text.value } });
      toast('Mensagem enviada para ' + item.customer_name);
      m.close();
      onSent?.();
    }, send),
  }, 'Enviar pelo WhatsApp');

  const m = modal({
    title: 'Lembrete para ' + item.customer_name,
    body: h('div', {},
      h('p', { class: 'small muted', style: { marginTop: 0 } },
        `${item.product_name} · última compra ${fmtDate(item.last_date)} (${item.daysSince} dias) · ${fmtPhone(item.phone)}`),
      field('Modelo', select),
      field('Mensagem', text, 'Você pode editar o texto antes de enviar.')),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), send],
  });
}

// ---------- Registrar contato (ligação, resultado, adiar) ----------
export function contactDialog(item, { onSaved, preset = {} } = {}) {
  const form = h('form', { onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'form-grid' },
      field('Como foi o contato', h('select', { name: 'channel' },
        Object.entries(CHANNELS).filter(([k]) => k !== 'whatsapp_auto').map(([k, v]) => h('option', { value: k, selected: k === (preset.channel || 'ligacao') }, v)))),
      field('Resultado', h('select', { name: 'result' },
        Object.entries(CONTACT_RESULTS).filter(([k]) => k !== 'adiado').map(([k, v]) => h('option', { value: k, selected: k === (preset.result || 'vai_comprar') }, v))))),
    field('Lembrar de novo daqui a', h('select', { name: 'snooze_days' },
      h('option', { value: 0 }, 'Padrão do sistema'),
      [3, 5, 7, 10, 15, 30].map((d) => h('option', { value: d, selected: d === preset.snooze_days }, d + ' dias'))),
    'Use para clientes que disseram "ainda tenho gás, me chama semana que vem".'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'block' }), 'Cliente pediu para não receber mais lembretes'),
    field('Observação', h('input', { name: 'notes', placeholder: 'Opcional' })));

  const save = h('button', {
    class: 'btn primary',
    onclick: () => attempt(async () => {
      const v = Object.fromEntries(new FormData(form));
      const block = form.querySelector('[name=block]').checked;
      const snooze = Number(v.snooze_days);
      await api('/api/contacts', {
        method: 'POST',
        body: {
          customer_id: item.customer_id, product_id: item.product_id, channel: v.channel,
          result: block ? 'nao_quer' : v.result, snooze_days: snooze, notes: v.notes, block,
        },
      });
      toast('Contato registrado');
      m.close();
      onSaved?.(v);
    }, save),
  }, 'Salvar');
  const m = modal({ title: 'Registrar contato — ' + item.customer_name, body: form, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
}

export function snoozeDialog(item, { onSaved } = {}) {
  const opts = [3, 7, 15, 30];
  const m = modal({
    title: 'Adiar lembrete — ' + item.customer_name,
    body: h('div', {},
      h('p', { style: { marginTop: 0 } }, 'Quando devemos lembrar de chamar esse cliente de novo?'),
      h('div', { class: 'btn-row' }, opts.map((d) => h('button', {
        class: 'btn',
        onclick: (e) => attempt(async () => {
          await api('/api/contacts', { method: 'POST', body: { customer_id: item.customer_id, product_id: item.product_id, channel: 'outro', result: 'adiado', snooze_days: d } });
          toast(`Adiado por ${d} dias`);
          m.close();
          onSaved?.();
        }, e.currentTarget),
      }, d + ' dias')))),
  });
}
