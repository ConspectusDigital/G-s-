import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- cycle_days: em quantos dias, em média, 1 unidade acaba. NULL = produto sem lembrete de recompra.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  cycle_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  phone_key TEXT,
  address TEXT NOT NULL DEFAULT '',
  neighborhood TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_key ON customers(phone_key) WHERE phone_key IS NOT NULL;
-- Ciclo definido manualmente para um cliente/produto (ex.: "esse cliente troca a cada 30 dias").
CREATE TABLE IF NOT EXISTS customer_cycles (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  days INTEGER NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'novo',
  payment_method TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'balcao',
  historical INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id, date);
CREATE INDEX IF NOT EXISTS orders_date ON orders(date);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  wa_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_phone ON messages(phone_key, id);
CREATE INDEX IF NOT EXISTS messages_wa ON messages(wa_id);
-- Cada tentativa de contato de recompra (WhatsApp, ligação...) e o resultado.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  result TEXT NOT NULL,
  snooze_until TEXT,
  notes TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_customer ON contacts(customer_id, date);
-- Controle do atendimento por conversa: IA ligada/desligada e pedidos de ajuda da IA.
CREATE TABLE IF NOT EXISTS chat_settings (
  phone_key TEXT PRIMARY KEY,
  ai_enabled INTEGER,
  needs_human INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'resposta',
  body TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  store_name: 'Minha Loja de Gás',
  timezone: 'America/Sao_Paulo',
  default_ddd: '',
  // Regras de lembrete
  lead_days: 5,
  recontact_days: 7,
  inactive_grace_days: 45,
  conversion_window_days: 7,
  // WhatsApp
  wa_provider: 'simulator',
  cloud_phone_number_id: '',
  cloud_token: '',
  cloud_verify_token: '',
  cloud_app_secret: '',
  cloud_api_version: 'v23.0',
  cloud_template_name: '',
  cloud_template_lang: 'pt_BR',
  cloud_template_params: 'nome,dias',
  evolution_url: '',
  evolution_instance: '',
  evolution_apikey: '',
  webhook_secret: '',
  // Envio automático de lembretes
  auto_send: false,
  auto_send_include_inactive: false,
  auto_send_daily_limit: 30,
  auto_send_max_attempts: 2,
  auto_send_start: '09:00',
  auto_send_end: '18:00',
  auto_send_days: [1, 2, 3, 4, 5, 6],
  send_delay_min: 20,
  send_delay_max: 60,
  // Atendimento
  business_hours_start: '07:00',
  business_hours_end: '19:00',
  away_enabled: false,
  away_message: 'Olá! No momento estamos fechados. Assim que abrirmos respondemos sua mensagem. 😊',
  notify_on_dispatch: false,
  opt_out_keywords: 'sair,parar,pare,cancelar lembretes',
  // IA de atendimento
  ai_enabled: false,
  ai_api_key: '',
  ai_model: 'claude-opus-5-5',
  ai_effort: 'low',
  ai_name: 'Bia',
  ai_instructions: '',
  ai_wait_seconds: 6,
  ai_pause_on_human: true,
  ai_handoff_message: 'Vou chamar alguém da equipe pra te ajudar, só um instante! 🙏',
  payment_methods: 'Dinheiro, Pix, cartão de débito e crédito',
  // Entrega
  store_address: '',
  store_city: '',
  store_lat: null,
  store_lng: null,
  delivery_fee_mode: 'gratis',
  delivery_fee_fixed: 0,
  delivery_free_km: 3,
  delivery_fee_per_km: 0,
  delivery_max_km: 0,
  delivery_eta: '30 a 60 minutos',
};

export const SECRET_SETTINGS = ['cloud_token', 'cloud_app_secret', 'evolution_apikey', 'ai_api_key'];

// Colunas adicionadas depois da primeira versão (bancos antigos ganham as colunas na hora).
const MIGRATIONS = [
  ['customers', 'latitude', 'REAL'],
  ['customers', 'longitude', 'REAL'],
  ['customers', 'location_source', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'delivery_fee', 'REAL NOT NULL DEFAULT 0'],
  ['orders', 'distance_km', 'REAL'],
  ['messages', 'sender', "TEXT NOT NULL DEFAULT ''"],
];

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const SEED_PRODUCTS = [
  ['Gás P13 (13 kg)', 110, 45],
  ['Gás P45 (45 kg)', 450, 60],
  ['Gás P5 (5 kg)', 65, 30],
  ['Água mineral 20 L', 15, 10],
  ['Vasilhame P13 (botijão vazio)', 180, null],
];

const SEED_TEMPLATES = [
  ['Lembrete de recompra', 'lembrete',
    'Olá, {nome}! Tudo bem? Aqui é da loja {loja} 😊\nSua última compra de {produto} foi há {dias} dias, então ele pode estar perto de acabar. Quer que a gente já leve um pra você? É só responder aqui!\n\n(Se não quiser mais receber lembretes, responda SAIR.)'],
  ['Reconquista (cliente sumido)', 'reconquista',
    'Oi, {nome}! Faz um tempinho que você não pede {produto} com a gente na loja {loja}. Sentimos sua falta! Precisando, é só chamar aqui que entregamos rapidinho. 🚚\n\n(Se não quiser mais receber lembretes, responda SAIR.)'],
  ['Pedido saiu para entrega', 'entrega', '{nome}, seu pedido saiu para entrega! Daqui a pouco chega aí. 🚚'],
  ['Pedido recebido', 'resposta', 'Pedido anotado, {nome}! Já já sai pra entrega. Obrigado pela preferência! 🙏'],
  ['Pedir endereço', 'resposta', 'Por favor, me confirma o endereço completo com ponto de referência e a forma de pagamento (dinheiro, Pix ou cartão)?'],
];

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
    const ins = db.prepare('INSERT INTO products (name, price, cycle_days) VALUES (?, ?, ?)');
    for (const p of SEED_PRODUCTS) ins.run(...p);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM templates').get().n === 0) {
    const ins = db.prepare('INSERT INTO templates (name, kind, body) VALUES (?, ?, ?)');
    for (const t of SEED_TEMPLATES) ins.run(...t);
  }
  // Segredos gerados uma única vez por instalação.
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ins.run('cloud_verify_token', JSON.stringify(randomBytes(12).toString('hex')));
  ins.run('webhook_secret', JSON.stringify(randomBytes(16).toString('hex')));
}

export function getSettings(db) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in DEFAULT_SETTINGS) settings[key] = JSON.parse(value);
  }
  return settings;
}

export function saveSettings(db, patch) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key];
    let v = value;
    if (def === null) v = value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    else if (typeof def === 'number') v = Number(value) || 0;
    else if (typeof def === 'boolean') v = Boolean(value);
    else if (Array.isArray(def)) v = Array.isArray(value) ? value.map(Number) : def;
    else v = String(value ?? '');
    up.run(key, JSON.stringify(v));
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
