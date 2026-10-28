// Funções utilitárias: datas locais, telefones brasileiros, CSV e templates.

export function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// Normaliza para o formato internacional usado pelo WhatsApp: 55 + DDD + número.
export function normalizePhone(raw, defaultDDD = '') {
  let d = onlyDigits(raw).replace(/^0+/, '');
  if (!d) return null;
  if ((d.length === 8 || d.length === 9) && defaultDDD) d = onlyDigits(defaultDDD) + d;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 ? d : null;
}

// Chave de comparação: DDD + 8 últimos dígitos. O WhatsApp às vezes entrega o
// número sem o nono dígito, então comparar pelo número completo falharia.
export function phoneKey(phone) {
  const d = onlyDigits(phone);
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d.slice(2, 4) + d.slice(-8);
  return d;
}

export function formatPhone(phone) {
  const d = onlyDigits(phone);
  if (d.startsWith('55') && d.length === 13) return `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `(${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  return d;
}

// Datas "de calendário" no fuso configurado (process.env.TZ), no formato YYYY-MM-DD.
export function localDate(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

export function localTime(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(11, 16);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(value + 'T00:00:00Z');
  // Date.parse aceita "31/02" e "pula" para março; conferimos se a data volta igual.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || '';
}

export function renderTemplate(body, vars) {
  return String(body).replace(/\{(\w+)\}/g, (match, key) => (vars[key] ?? match));
}

// Parser de CSV simples (aceita vírgula ou ponto e vírgula e campos entre aspas).
export function parseCSV(text) {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\n');
}

// Converte "dd/mm/aaaa" ou "aaaa-mm-dd" em "aaaa-mm-dd".
export function parseBrDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    const iso = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidDate(iso) ? iso : null;
  }
  m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m && isValidDate(m[0]) ? m[0] : null;
}
