// Estado compartilhado (produtos, modelos) e eventos em tempo real do servidor.
import { api } from './lib.js';

export const store = { products: [], templates: [], me: null };

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) {
  for (const fn of listeners.get(event) || []) fn(data);
}

export async function loadProducts() {
  store.products = await api('/api/products');
  return store.products;
}

export async function loadTemplates() {
  store.templates = await api('/api/templates');
  return store.templates;
}

let source;
export function connectEvents() {
  source?.close();
  source = new EventSource('/api/events');
  for (const ev of ['message', 'read', 'orders', 'reminders', 'queue']) {
    source.addEventListener(ev, (e) => emit(ev, JSON.parse(e.data)));
  }
}
export function disconnectEvents() {
  source?.close();
  source = null;
}
