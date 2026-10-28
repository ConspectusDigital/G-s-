import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, learnCycle } from '../src/services/reminders.js';
import { normalizePhone, parseBrDate, parseCSV, phoneKey } from '../src/util.js';
import { parseCloudWebhook } from '../src/whatsapp/cloud.js';
import { parseEvolutionWebhook } from '../src/whatsapp/evolution.js';

const settings = { lead_days: 5, recontact_days: 7, inactive_grace_days: 45 };

test('sem histórico usa o ciclo padrão do produto', () => {
  assert.deepEqual(learnCycle([{ date: '2026-01-01', quantity: 1 }], 45), { days: 45, source: 'padrao', samples: 0 });
});

test('aprende o ciclo pela mediana dos intervalos', () => {
  const r = learnCycle([
    { date: '2026-01-01', quantity: 1 },
    { date: '2026-01-31', quantity: 1 },
    { date: '2026-03-02', quantity: 1 },
    { date: '2026-04-11', quantity: 1 },
  ], 45);
  assert.equal(r.source, 'historico');
  assert.equal(r.days, 30); // intervalos 30, 30, 40 → mediana 30
});

test('compra de 2 unidades conta como o dobro do tempo', () => {
  const r = learnCycle([
    { date: '2026-01-01', quantity: 2 },
    { date: '2026-03-02', quantity: 1 },
    { date: '2026-04-01', quantity: 1 },
  ], 45);
  assert.equal(r.days, 30); // 60/2 = 30 e 30/1 = 30
});

test('com um único intervalo mistura com o padrão', () => {
  const r = learnCycle([{ date: '2026-01-01', quantity: 1 }, { date: '2026-01-31', quantity: 1 }], 50);
  assert.equal(r.days, 40);
});

const base = { lastDate: '2026-01-01', lastQty: 1, unitCycle: 45, manualCycle: null, contacts: [], doNotContact: false, settings };

test('em dia antes da data de aviso', () => {
  const r = evaluate({ ...base, today: '2026-02-09' }); // aviso em 10/02
  assert.equal(r.status, 'em_dia');
  assert.equal(r.dueDate, '2026-02-15');
});

test('chamar a partir de alguns dias antes de acabar', () => {
  assert.equal(evaluate({ ...base, today: '2026-02-10' }).status, 'chamar');
  assert.equal(evaluate({ ...base, today: '2026-03-01' }).status, 'chamar');
});

test('vira reconquista depois do prazo de tolerância', () => {
  assert.equal(evaluate({ ...base, today: '2026-04-01' }).status, 'inativo');
});

test('contato recente deixa aguardando e volta depois', () => {
  const contacts = [{ date: '2026-02-12', created_at: '2026-02-12T12:00:00Z', channel: 'whatsapp', snooze_until: null }];
  assert.equal(evaluate({ ...base, contacts, today: '2026-02-15' }).status, 'aguardando');
  assert.equal(evaluate({ ...base, contacts, today: '2026-02-19' }).status, 'chamar');
});

test('adiamento respeita a data escolhida', () => {
  const contacts = [{ date: '2026-02-12', created_at: '2026-02-12T12:00:00Z', channel: 'ligacao', snooze_until: '2026-02-20' }];
  assert.equal(evaluate({ ...base, contacts, today: '2026-02-19' }).status, 'adiado');
  assert.equal(evaluate({ ...base, contacts, today: '2026-02-20' }).status, 'chamar');
});

test('contatos anteriores à última compra são ignorados', () => {
  const contacts = [{ date: '2025-12-20', created_at: '2025-12-20T12:00:00Z', channel: 'whatsapp', snooze_until: null }];
  assert.equal(evaluate({ ...base, contacts, today: '2026-02-12' }).status, 'chamar');
});

test('ciclo manual tem prioridade e cliente bloqueado não é chamado', () => {
  assert.equal(evaluate({ ...base, manualCycle: 20, today: '2026-01-16' }).status, 'chamar');
  assert.equal(evaluate({ ...base, doNotContact: true, today: '2026-03-01' }).status, 'bloqueado');
});

test('telefones brasileiros', () => {
  assert.equal(normalizePhone('(11) 98765-4321'), '5511987654321');
  assert.equal(normalizePhone('98765-4321', '21'), '5521987654321');
  assert.equal(normalizePhone('123'), null);
  // Mesmo cliente com e sem o nono dígito
  assert.equal(phoneKey('5511987654321'), phoneKey('551187654321'));
});

test('datas e CSV', () => {
  assert.equal(parseBrDate('5/9/2026'), '2026-09-05');
  assert.equal(parseBrDate('31/02/2026'), null);
  assert.deepEqual(parseCSV('nome;telefone\n"Silva; Maria";11 9999\n'), [['nome', 'telefone'], ['Silva; Maria', '11 9999']]);
});

test('webhook da Cloud API', () => {
  const events = parseCloudWebhook({
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '5511987654321', profile: { name: 'Maria' } }],
      messages: [{ from: '5511987654321', id: 'wamid.1', type: 'text', text: { body: 'Quero gás' } }],
      statuses: [{ id: 'wamid.0', status: 'read' }],
    } }] }],
  });
  assert.deepEqual(events[0], { type: 'message', phone: '5511987654321', name: 'Maria', body: 'Quero gás', waId: 'wamid.1', fromMe: false, location: null });
  assert.deepEqual(events[1], { type: 'status', waId: 'wamid.0', status: 'read', error: null });
});

test('webhook da Evolution API (inclui @lid e ignora grupos)', () => {
  const events = parseEvolutionWebhook({
    event: 'messages.upsert',
    data: [
      { key: { remoteJid: '5511987654321@s.whatsapp.net', fromMe: false, id: 'A1' }, pushName: 'João', message: { conversation: 'oi' } },
      { key: { remoteJid: '123@lid', remoteJidAlt: '5511912345678@s.whatsapp.net', fromMe: false, id: 'A2' }, message: { extendedTextMessage: { text: 'olá' } } },
      { key: { remoteJid: '1203@g.us', id: 'A3' }, message: { conversation: 'grupo' } },
    ],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].phone, '5511987654321');
  assert.equal(events[1].phone, '5511912345678');
  assert.equal(events[1].body, 'olá');
});
