// Preenche um banco de demonstração com clientes e pedidos fictícios.
// Uso: npm run demo   (cria data/demo.db; depois: DB_PATH=data/demo.db npm start)
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, saveSettings } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { addDays, localDate, phoneKey } from '../src/util.js';

process.env.TZ = 'America/Sao_Paulo';
const path = process.env.DB_PATH || join(process.cwd(), 'data', 'demo.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
const db = openDatabase(path);

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Maria', 'José', 'Ana', 'João', 'Francisca', 'Antônio', 'Adriana', 'Carlos', 'Juliana', 'Paulo', 'Márcia', 'Pedro', 'Aline', 'Lucas', 'Sandra', 'Rafael', 'Patrícia', 'Marcos', 'Fernanda', 'Luiz', 'Cláudia', 'Rodrigo', 'Vera', 'Bruno'];
const LAST = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Ferreira', 'Rodrigues', 'Almeida', 'Nascimento', 'Carvalho'];
const STREETS = ['Rua das Flores', 'Rua São João', 'Av. Brasil', 'Rua Sete de Setembro', 'Rua Dom Pedro II', 'Travessa Esperança', 'Rua Tiradentes'];
const HOODS = ['Centro', 'Jardim América', 'Vila Nova', 'São José', 'Boa Vista', 'Santa Rita'];
const PAY = ['dinheiro', 'pix', 'pix', 'debito', 'credito', 'fiado'];

const today = localDate();
const now = new Date().toISOString();
db.prepare('INSERT INTO users (name, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('Administrador', 'admin', hashPassword('admin123'), now);
saveSettings(db, { store_name: 'Gás do Tio', default_ddd: '11' });

const insCustomer = db.prepare(`INSERT INTO customers (name, phone, phone_key, address, neighborhood, reference, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, '', ?, ?)`);
const insOrder = db.prepare(`INSERT INTO orders (customer_id, date, status, payment_method, total, source, created_at)
  VALUES (?, ?, 'entregue', ?, ?, ?, ?)`);
const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');

for (let i = 0; i < 60; i++) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const phone = '55119' + String(80000000 + Math.floor(rand() * 19999999)).padStart(8, '0');
  const { lastInsertRowid } = insCustomer.run(name, phone, phoneKey(phone), `${pick(STREETS)}, ${10 + Math.floor(rand() * 900)}`, pick(HOODS), now, now);
  const id = Number(lastInsertRowid);
  // Cada cliente tem um ritmo próprio de consumo (25 a 75 dias por botijão).
  const cycle = 25 + Math.floor(rand() * 50);
  const water = rand() < 0.3;
  let date = addDays(today, -(Math.floor(rand() * cycle * 1.6) + 1));
  const purchases = [];
  for (let k = 0; k < 2 + Math.floor(rand() * 4); k++) {
    purchases.unshift(date);
    date = addDays(date, -(cycle + Math.floor(rand() * 9) - 4));
  }
  for (const d of purchases) {
    const o = Number(insOrder.run(id, d, pick(PAY), 110, pick(['whatsapp', 'whatsapp', 'telefone', 'balcao']), now).lastInsertRowid);
    insItem.run(o, 1, 1, 110);
    if (water) insItem.run(o, 4, 2, 15);
  }
}
// Pedidos de hoje para o painel não ficar vazio.
const ids = db.prepare('SELECT id FROM customers ORDER BY RANDOM() LIMIT 3').all();
for (const { id } of ids) {
  const o = Number(db.prepare(`INSERT INTO orders (customer_id, date, status, payment_method, total, source, created_at) VALUES (?, ?, 'novo', 'pix', 110, 'whatsapp', ?)`)
    .run(id, today, now).lastInsertRowid);
  insItem.run(o, 1, 1, 110);
}
console.log(`Banco de demonstração criado em ${path}`);
console.log('Login: admin / admin123');
