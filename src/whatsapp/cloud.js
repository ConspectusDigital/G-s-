// WhatsApp Cloud API (oficial da Meta).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
import { createHmac, timingSafeEqual } from 'node:crypto';

const MEDIA_LABELS = {
  image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]',
  sticker: '[figurinha]', contacts: '[contato]', reaction: '[reação]',
};

export function createCloudProvider(settings) {
  const base = `https://graph.facebook.com/${settings.cloud_api_version}/${settings.cloud_phone_number_id}`;

  async function post(payload) {
    if (!settings.cloud_phone_number_id || !settings.cloud_token) throw new Error('WhatsApp Cloud API não configurada');
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.cloud_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      // 131047 = mais de 24h desde a última mensagem do cliente: só template aprovado é permitido.
      if (err.code === 131047) throw new Error('Mais de 24h sem mensagem do cliente: a Meta só permite enviar um modelo (template) aprovado.');
      throw new Error(err.message || `Erro ${res.status} na API do WhatsApp`);
    }
    return { waId: data.messages?.[0]?.id || null };
  }

  return {
    name: 'cloud',
    // windowOpen: o cliente mandou mensagem nas últimas 24h (pode receber texto livre).
    async send(phone, text, { windowOpen = true, vars = null } = {}) {
      if (!windowOpen && vars && settings.cloud_template_name) {
        const params = settings.cloud_template_params.split(',').map((s) => s.trim()).filter(Boolean)
          .map((key) => ({ type: 'text', text: String(vars[key] ?? '') }));
        return post({
          to: phone,
          type: 'template',
          template: {
            name: settings.cloud_template_name,
            language: { code: settings.cloud_template_lang || 'pt_BR' },
            components: params.length ? [{ type: 'body', parameters: params }] : [],
          },
        });
      }
      return post({ to: phone, type: 'text', text: { body: text, preview_url: false } });
    },

    verifyChallenge(query) {
      if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === settings.cloud_verify_token) {
        return query.get('hub.challenge');
      }
      return null;
    },

    verifySignature(rawBody, header) {
      if (!settings.cloud_app_secret) return true;
      if (!header?.startsWith('sha256=')) return false;
      const expected = createHmac('sha256', settings.cloud_app_secret).update(rawBody).digest();
      const given = Buffer.from(header.slice(7), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    parseWebhook: parseCloudWebhook,
  };
}

export function parseCloudWebhook(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        events.push({
          type: 'message',
          phone: m.from,
          name: names.get(m.from) || null,
          body: describeCloudMessage(m),
          waId: m.id,
          fromMe: false,
        });
      }
      for (const s of value.statuses || []) {
        events.push({ type: 'status', waId: s.id, status: s.status, error: s.errors?.[0]?.title || null });
      }
    }
  }
  return events;
}

function describeCloudMessage(m) {
  switch (m.type) {
    case 'text': return m.text?.body || '';
    case 'button': return m.button?.text || '[botão]';
    case 'interactive': return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '[resposta]';
    case 'location': {
      const { latitude, longitude, address, name } = m.location || {};
      return `📍 Localização: ${[name, address].filter(Boolean).join(' - ')} https://maps.google.com/?q=${latitude},${longitude}`.trim();
    }
    default: {
      const caption = m[m.type]?.caption;
      return (MEDIA_LABELS[m.type] || `[${m.type}]`) + (caption ? ' ' + caption : '');
    }
  }
}
