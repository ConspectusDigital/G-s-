// Evolution API (https://doc.evolution-api.com): conecta um WhatsApp comum ou
// Business lendo um QR Code. Não é oficial da Meta: use com moderação para
// evitar bloqueio do número.

const MEDIA_LABELS = {
  imageMessage: '[imagem]', audioMessage: '[áudio]', videoMessage: '[vídeo]',
  documentMessage: '[documento]', stickerMessage: '[figurinha]', contactMessage: '[contato]',
};

export function createEvolutionProvider(settings) {
  const base = settings.evolution_url.replace(/\/+$/, '');
  const instance = encodeURIComponent(settings.evolution_instance);

  async function call(method, path, body) {
    if (!base || !settings.evolution_instance || !settings.evolution_apikey) throw new Error('Evolution API não configurada');
    const res = await fetch(base + path, {
      method,
      headers: { apikey: settings.evolution_apikey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.response?.message || data?.message || `Erro ${res.status} na Evolution API`;
      throw new Error(Array.isArray(msg) ? msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ') : String(msg));
    }
    return data;
  }

  return {
    name: 'evolution',
    async send(phone, text) {
      const data = await call('POST', `/message/sendText/${instance}`, { number: phone, text });
      return { waId: data?.key?.id || null };
    },
    async status() {
      const data = await call('GET', `/instance/connectionState/${instance}`);
      return { connected: data?.instance?.state === 'open', state: data?.instance?.state || 'desconhecido' };
    },
    async qrcode() {
      const data = await call('GET', `/instance/connect/${instance}`);
      return { base64: data?.base64 || null, pairingCode: data?.pairingCode || null };
    },
    parseWebhook: parseEvolutionWebhook,
  };
}

export function parseEvolutionWebhook(body) {
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  const items = Array.isArray(body?.data) ? body.data : [body?.data].filter(Boolean);
  const events = [];
  if (event === 'messages.upsert') {
    for (const d of items) {
      const key = d.key || {};
      let jid = key.remoteJid || '';
      // Contas com o novo identificador "@lid" trazem o número real em outro campo.
      if (jid.endsWith('@lid')) jid = key.remoteJidAlt || key.senderPn || d.senderPn || '';
      if (!jid.endsWith('@s.whatsapp.net')) continue; // ignora grupos, status e canais
      events.push({
        type: 'message',
        phone: jid.split('@')[0],
        name: key.fromMe ? null : d.pushName || null,
        body: describeEvolutionMessage(d.message || {}, d.messageType),
        waId: key.id || null,
        fromMe: Boolean(key.fromMe),
      });
    }
  } else if (event === 'messages.update') {
    const map = { DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read', SERVER_ACK: 'sent', ERROR: 'failed' };
    for (const d of items) {
      const status = map[d.status];
      const waId = d.keyId || d.key?.id;
      if (status && waId) events.push({ type: 'status', waId, status, error: null });
    }
  }
  return events;
}

function describeEvolutionMessage(message, messageType) {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng, address, name } = message.locationMessage;
    return `📍 Localização: ${[name, address].filter(Boolean).join(' - ')} https://maps.google.com/?q=${lat},${lng}`.trim();
  }
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedDisplayText || '[botão]';
  for (const [k, label] of Object.entries(MEDIA_LABELS)) {
    if (message[k]) return label + (message[k].caption ? ' ' + message[k].caption : '');
  }
  return messageType ? `[${messageType}]` : '[mensagem]';
}
