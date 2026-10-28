// Utilitários de interface: criação de elementos, chamadas à API, modais e formatação.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/login')) {
    window.dispatchEvent(new Event('unauthorized'));
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export function toast(message, type = 'info') {
  const el = h('div', { class: 'toast ' + type }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

// Executa uma ação mostrando erro em toast; desabilita o botão enquanto roda.
export async function attempt(fn, button) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

export function modal({ title, body, footer = [], wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog' },
      h('header', {}, h('h2', {}, title), h('button', { class: 'x', onclick: close, 'aria-label': 'Fechar' }, '×')),
      h('div', { class: 'body' }, body),
      footer.length ? h('footer', {}, footer) : null));
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  back.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  return { close, el: back };
}

export function confirmDialog(message, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: 'Confirmar',
      body: h('p', {}, message),
      footer: [
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; m.close(); resolve(true); } }, ok),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtMoney = (v) => money.format(Number(v) || 0);
export const fmtDate = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) return `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `(${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  return d;
}

export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDaysISO(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

export function relDays(n) {
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  if (n === -1) return 'ontem';
  return n > 0 ? `em ${n} dias` : `há ${-n} dias`;
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter((p) => /^\p{L}/u.test(p));
  if (!parts.length) return '#';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const STATUS = {
  chamar: { label: 'Chamar agora', cls: 'danger' },
  aguardando: { label: 'Aguardando resposta', cls: 'info' },
  adiado: { label: 'Adiado', cls: '' },
  inativo: { label: 'Reconquistar', cls: 'warn' },
  em_dia: { label: 'Em dia', cls: 'ok' },
  bloqueado: { label: 'Não contatar', cls: '' },
};

export const ORDER_STATUS = {
  novo: { label: 'Novo', cls: 'brand' },
  saiu: { label: 'Saiu p/ entrega', cls: 'info' },
  entregue: { label: 'Entregue', cls: 'ok' },
  cancelado: { label: 'Cancelado', cls: '' },
};

export const PAYMENTS = { '': '—', dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Cartão débito', credito: 'Cartão crédito', fiado: 'Fiado' };
export const SOURCES = { whatsapp: 'WhatsApp', telefone: 'Telefone', balcao: 'Balcão', lembrete: 'Após lembrete', historico: 'Histórico' };
export const CONTACT_RESULTS = {
  enviado: 'Mensagem enviada', respondeu: 'Respondeu', vai_comprar: 'Vai comprar', sem_resposta: 'Sem resposta',
  nao_atendeu: 'Não atendeu', nao_quer: 'Não quer agora', adiado: 'Adiado', comprou: 'Comprou',
};
export const CHANNELS = { whatsapp: 'WhatsApp', whatsapp_auto: 'WhatsApp (automático)', ligacao: 'Ligação', presencial: 'Presencial', outro: 'Outro' };
