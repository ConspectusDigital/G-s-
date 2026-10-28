import { api, attempt, field, h, mount, toast } from './lib.js';
import { connectEvents, disconnectEvents, on, store } from './store.js';
import * as dashboard from './views/dashboard.js';
import * as reminders from './views/reminders.js';
import * as chat from './views/chat.js';
import * as orders from './views/orders.js';
import * as customers from './views/customers.js';
import * as settings from './views/settings.js';

const ROUTES = {
  painel: { view: dashboard, label: 'Painel', ico: '📊' },
  lembretes: { view: reminders, label: 'Chamar', ico: '🔔', badge: 'chamar' },
  atendimento: { view: chat, label: 'Atendimento', ico: '💬', badge: 'unread' },
  pedidos: { view: orders, label: 'Pedidos', ico: '🧾' },
  clientes: { view: customers, label: 'Clientes', ico: '👥' },
  config: { view: settings, label: 'Config.', ico: '⚙️' },
};

const app = document.getElementById('app');
let current = { name: null, handle: null };
let badges = { chamar: 0, unread: 0 };

// ---------- Login / primeiro acesso ----------
async function showLogin() {
  disconnectEvents();
  const { needed } = await api('/api/setup');
  const form = h('form', {},
    needed ? field('Seu nome', h('input', { name: 'name', required: true })) : null,
    field('Usuário', h('input', { name: 'username', autocapitalize: 'off', autocomplete: 'username', required: true })),
    field('Senha', h('input', { name: 'password', type: 'password', autocomplete: needed ? 'new-password' : 'current-password', required: true })),
    h('button', { class: 'btn primary', style: { width: '100%' }, type: 'submit' }, needed ? 'Criar acesso e entrar' : 'Entrar'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      await api(needed ? '/api/setup' : '/api/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      start();
    }, form.querySelector('button'));
  });
  mount(app, h('div', { class: 'login-wrap' }, h('div', { class: 'card login' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, '🔥'), 'Gás Atendimento'),
    needed ? h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Primeiro acesso: crie o usuário administrador da loja.') : null,
    form)));
}

window.addEventListener('unauthorized', () => { if (store.me) { store.me = null; showLogin(); } });

// ---------- Layout ----------
function layout() {
  const nav = h('nav', { class: 'nav' }, Object.entries(ROUTES).map(([k, r]) => h('a', { href: '#/' + k, 'data-route': k },
    h('span', { class: 'ico' }, r.ico), h('span', {}, r.label), r.badge ? h('span', { class: 'badge brand hidden', 'data-badge': r.badge }) : null)));
  const waState = h('div', { class: 'wa-state' }, h('span', { class: 'dot' }), h('span', {}, 'WhatsApp…'));
  mount(app, h('div', { class: 'layout' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '🔥'), h('span', { id: 'store-name' }, 'Gás Atendimento')),
      nav,
      h('div', { class: 'side-foot' }, waState,
        h('div', {}, store.me.name, ' · ', h('button', { onclick: logout }, 'Sair')))),
    h('main', { class: 'main', id: 'view' })));
  refreshStatus();
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  store.me = null;
  showLogin();
}

async function refreshStatus() {
  try {
    const [st, cfg] = await Promise.all([api('/api/whatsapp/status'), api('/api/settings')]);
    window.STORE_NAME = cfg.settings.store_name;
    const nameEl = document.getElementById('store-name');
    if (nameEl) nameEl.textContent = cfg.settings.store_name;
    document.title = cfg.settings.store_name + ' — Atendimento';
    const el = document.querySelector('.wa-state');
    if (el) mount(el, h('span', { class: 'dot ' + (st.connected ? 'on' : 'off') }),
      h('a', { href: '#/config/whatsapp', style: { color: 'inherit' } }, st.provider === 'simulator' ? 'Modo simulador' : st.connected ? 'WhatsApp conectado' : 'WhatsApp desconectado'));
  } catch { /* sessão expirada: tratado pelo evento unauthorized */ }
}
window.addEventListener('settings-changed', refreshStatus);

async function refreshBadges() {
  try {
    const d = await api('/api/dashboard');
    badges = { chamar: d.counts.chamar || 0, unread: d.unread + d.needsHuman };
    for (const el of document.querySelectorAll('[data-badge]')) {
      const n = badges[el.dataset.badge];
      el.textContent = n > 99 ? '99+' : n;
      el.classList.toggle('hidden', !n);
    }
    const total = badges.unread;
    document.title = (total ? `(${total}) ` : '') + (window.STORE_NAME || 'Gás') + ' — Atendimento';
  } catch { /* ignora */ }
}

let badgeTimer;
const scheduleBadges = () => { clearTimeout(badgeTimer); badgeTimer = setTimeout(refreshBadges, 400); };

// ---------- Rotas ----------
function route() {
  if (!store.me) return;
  const [name = 'painel', ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const r = ROUTES[name] || ROUTES.painel;
  const key = ROUTES[name] ? name : 'painel';
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.route === key);

  // Algumas telas (atendimento, config.) trocam de conteúdo sem recriar tudo.
  if (current.name === key && current.handle?.update) {
    current.handle.update(params);
    return;
  }
  const h0 = current.handle;
  if (typeof h0 === 'function') h0();
  else h0?.cleanup?.();
  const view = document.getElementById('view');
  view.replaceChildren();
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  current = { name: key, handle: r.view.render(view, params) };
}
window.addEventListener('hashchange', route);

// ---------- Notificações ----------
function notify(m) {
  if (m.direction !== 'in' || m.status !== 'received') return;
  const inChat = location.hash.startsWith('#/atendimento') && document.visibilityState === 'visible';
  if (!inChat) toast('💬 Nova mensagem: ' + m.body.slice(0, 60));
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification('Nova mensagem no WhatsApp', { body: m.body.slice(0, 120), tag: m.phone_key });
    n.onclick = () => { window.focus(); location.hash = '#/atendimento/' + m.phone; };
  }
}
const seen = new Set();
on('message', (m) => {
  scheduleBadges();
  if (!seen.has(m.id)) { seen.add(m.id); notify(m); }
});
for (const ev of ['read', 'reminders', 'orders']) on(ev, scheduleBadges);
// A IA pediu ajuda de uma pessoa.
on('handoff', (d) => {
  scheduleBadges();
  if (!d.reason || d.paused) return;
  toast(`⚠️ ${d.name || 'Cliente'} precisa de atendimento: ${d.reason}`, 'error');
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification('Cliente precisa de atendimento', { body: `${d.name || ''}: ${d.reason}`, tag: 'handoff-' + d.phone_key });
    n.onclick = () => { window.focus(); if (d.phone) location.hash = '#/atendimento/' + d.phone; };
  }
});

async function start() {
  try {
    store.me = await api('/api/me');
  } catch {
    showLogin();
    return;
  }
  layout();
  connectEvents();
  current = { name: null, handle: null };
  route();
  refreshBadges();
  if (!window.badgeInterval) window.badgeInterval = setInterval(refreshBadges, 5 * 60 * 1000);
  if ('Notification' in window && Notification.permission === 'default') {
    // Pede permissão no primeiro clique (navegadores bloqueiam o pedido sem interação).
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
}

start();
