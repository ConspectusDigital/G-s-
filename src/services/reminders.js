// Previsão de recompra: estima quando o produto de cada cliente vai acabar e
// decide quem precisa ser chamado hoje.
import { addDays, daysBetween, firstName, localDate, median, renderTemplate } from '../util.js';

const MIN_CYCLE = 7;
const MAX_CYCLE = 365;
const MAX_INTERVALS = 6;

export const STATUS_LABELS = {
  chamar: 'Chamar agora',
  aguardando: 'Aguardando resposta',
  adiado: 'Adiado',
  inativo: 'Reconquistar',
  em_dia: 'Em dia',
  bloqueado: 'Não contatar',
};

// purchases: [{ date: 'YYYY-MM-DD', quantity }] de um cliente para um produto.
// Retorna em quantos dias UMA unidade costuma acabar para esse cliente.
export function learnCycle(purchases, defaultCycle) {
  const byDate = new Map();
  for (const p of purchases) byDate.set(p.date, (byDate.get(p.date) || 0) + Math.max(1, p.quantity));
  const dates = [...byDate.keys()].sort();
  const perUnit = [];
  for (let i = 0; i + 1 < dates.length; i++) {
    const gap = daysBetween(dates[i], dates[i + 1]);
    // Compras muito próximas costumam ser reposição extra, não consumo normal.
    if (gap >= 3) perUnit.push(gap / byDate.get(dates[i]));
  }
  const recent = perUnit.slice(-MAX_INTERVALS);
  if (!recent.length) return { days: defaultCycle, source: 'padrao', samples: 0 };
  // Com só um intervalo, mistura com o padrão para não exagerar num caso isolado.
  const learned = recent.length === 1 ? (recent[0] + defaultCycle) / 2 : median(recent);
  const days = Math.min(MAX_CYCLE, Math.max(MIN_CYCLE, Math.round(learned)));
  return { days, source: 'historico', samples: recent.length };
}

// Decide a situação de um par cliente/produto.
export function evaluate({ lastDate, lastQty, unitCycle, manualCycle, contacts, doNotContact, today, settings }) {
  const cycle = manualCycle || Math.max(MIN_CYCLE, Math.round(unitCycle * Math.max(1, lastQty)));
  const daysSince = daysBetween(lastDate, today);
  const dueDate = addDays(lastDate, cycle);
  const alertDate = addDays(dueDate, -settings.lead_days);
  const daysToDue = daysBetween(today, dueDate);
  const after = contacts.filter((c) => c.date > lastDate).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const lastContact = after[0] || null;

  let status;
  if (doNotContact) status = 'bloqueado';
  else if (today < alertDate) status = 'em_dia';
  else if (lastContact?.snooze_until && lastContact.snooze_until > today) status = 'adiado';
  else if (lastContact && !lastContact.snooze_until && daysBetween(lastContact.date, today) < settings.recontact_days) status = 'aguardando';
  else status = daysSince >= cycle + settings.inactive_grace_days ? 'inativo' : 'chamar';

  return {
    cycle,
    daysSince,
    dueDate,
    alertDate,
    daysToDue,
    late: daysToDue < 0,
    status,
    lastContact,
    attempts: after.length,
    autoAttempts: after.filter((c) => c.channel === 'whatsapp_auto').length,
  };
}

// Calcula a situação de todos os clientes (ou de um só) para todos os produtos com ciclo.
export function computeReminders(db, settings, { customerId = null, today = localDate() } = {}) {
  const where = customerId ? 'AND o.customer_id = ?' : '';
  const args = customerId ? [customerId] : [];
  const rows = db.prepare(`
    SELECT o.customer_id, oi.product_id, o.date, SUM(oi.quantity) AS quantity
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    WHERE o.status != 'cancelado' AND p.cycle_days IS NOT NULL ${where}
    GROUP BY o.customer_id, oi.product_id, o.date
    ORDER BY o.date`).all(...args);

  const groups = new Map();
  for (const r of rows) {
    const k = r.customer_id + ':' + r.product_id;
    if (!groups.has(k)) groups.set(k, { customerId: r.customer_id, productId: r.product_id, purchases: [] });
    groups.get(k).purchases.push({ date: r.date, quantity: r.quantity });
  }
  if (!groups.size) return [];

  const products = new Map(db.prepare('SELECT id, name, cycle_days FROM products').all().map((p) => [p.id, p]));
  const customers = new Map(db.prepare(`SELECT id, name, phone, neighborhood, address, do_not_contact FROM customers ${customerId ? 'WHERE id = ?' : ''}`)
    .all(...args).map((c) => [c.id, c]));
  const manual = new Map(db.prepare('SELECT customer_id, product_id, days FROM customer_cycles').all()
    .map((m) => [m.customer_id + ':' + m.product_id, m.days]));
  const contactsByCustomer = new Map();
  for (const c of db.prepare(`SELECT * FROM contacts ${customerId ? 'WHERE customer_id = ?' : ''}`).all(...args)) {
    if (!contactsByCustomer.has(c.customer_id)) contactsByCustomer.set(c.customer_id, []);
    contactsByCustomer.get(c.customer_id).push(c);
  }

  const result = [];
  for (const [key, g] of groups) {
    const product = products.get(g.productId);
    const customer = customers.get(g.customerId);
    if (!product || !customer || product.cycle_days == null) continue;
    const learned = learnCycle(g.purchases, product.cycle_days);
    const last = g.purchases[g.purchases.length - 1];
    const manualCycle = manual.get(key) || null;
    const contacts = (contactsByCustomer.get(g.customerId) || [])
      .filter((c) => c.product_id == null || c.product_id === g.productId);
    const ev = evaluate({
      lastDate: last.date,
      lastQty: last.quantity,
      unitCycle: learned.days,
      manualCycle,
      contacts,
      doNotContact: Boolean(customer.do_not_contact),
      today,
      settings,
    });
    result.push({
      customer_id: customer.id,
      customer_name: customer.name,
      phone: customer.phone,
      neighborhood: customer.neighborhood,
      address: customer.address,
      product_id: product.id,
      product_name: product.name,
      last_date: last.date,
      last_qty: last.quantity,
      purchases: g.purchases.length,
      cycle_source: manualCycle ? 'manual' : learned.source,
      unit_cycle: learned.days,
      ...ev,
    });
  }

  // Quem está mais atrasado aparece primeiro.
  return result.sort((a, b) => a.daysToDue - b.daysToDue);
}

export function reminderVars(item, settings) {
  return {
    nome: firstName(item.customer_name),
    nome_completo: item.customer_name,
    produto: item.product_name,
    dias: String(item.daysSince),
    data_ultima: item.last_date.split('-').reverse().join('/'),
    loja: settings.store_name,
  };
}

export function renderForItem(templateBody, item, settings) {
  return renderTemplate(templateBody, reminderVars(item, settings));
}

export function pickTemplate(db, item) {
  const kind = item.status === 'inativo' ? 'reconquista' : 'lembrete';
  return db.prepare('SELECT * FROM templates WHERE kind = ? ORDER BY id LIMIT 1').get(kind)
    || db.prepare("SELECT * FROM templates WHERE kind = 'lembrete' ORDER BY id LIMIT 1").get();
}
