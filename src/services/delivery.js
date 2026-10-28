// Distância até o cliente e cálculo da taxa de entrega.
// Endereço → coordenadas: Nominatim (OpenStreetMap). Distância de carro: OSRM.
// Se o roteamento falhar, usa a distância em linha reta × 1,3 (aproximação de ruas).
const UA = 'gas-atendimento/1.0 (sistema de atendimento de revenda de gas)';
const ROAD_FACTOR = 1.3;

async function fetchJSON(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// O Nominatim pede no máximo 1 consulta por segundo.
let lastGeocode = 0;
export async function geocode(address) {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=' + encodeURIComponent(address);
  const [hit] = await fetchJSON(url);
  if (!hit) return null;
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name };
}

export function straightKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export async function distanceKm(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const data = await fetchJSON(url, 6000);
    const meters = data.routes?.[0]?.distance;
    if (Number.isFinite(meters)) return { km: meters / 1000, method: 'rota' };
  } catch { /* cai para a estimativa */ }
  return { km: straightKm(from, to) * ROAD_FACTOR, method: 'estimativa' };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Aplica as regras de taxa configuradas a uma distância (ou sem distância, nos modos que não precisam dela).
export function feeForDistance(settings, km) {
  const mode = settings.delivery_fee_mode;
  if (mode === 'gratis') return { fee: 0, rule: 'Entrega grátis' };
  if (mode === 'fixa') return { fee: round2(settings.delivery_fee_fixed), rule: 'Taxa fixa de entrega' };
  // por_distancia: grátis até X km; acima disso, taxa fixa + valor por km excedente.
  if (km == null) return null;
  if (settings.delivery_max_km > 0 && km > settings.delivery_max_km) {
    return { fee: null, outOfRange: true, rule: `Não entregamos acima de ${settings.delivery_max_km} km` };
  }
  if (km <= settings.delivery_free_km) return { fee: 0, rule: `Grátis até ${settings.delivery_free_km} km` };
  const extraKm = Math.ceil(km - settings.delivery_free_km);
  return {
    fee: round2(settings.delivery_fee_fixed + extraKm * settings.delivery_fee_per_km),
    rule: `Acima de ${settings.delivery_free_km} km`,
  };
}

// Calcula a taxa para um cliente (usa coordenadas salvas, ou localiza o endereço e salva).
export async function quoteDelivery(ctx, customer, { address = null } = {}) {
  const settings = ctx.settings();
  if (settings.delivery_fee_mode !== 'por_distancia') {
    return { ok: true, ...feeForDistance(settings, null), distance_km: null };
  }
  if (settings.store_lat == null || settings.store_lng == null) {
    return { ok: false, error: 'A localização da loja não foi configurada. Não é possível calcular a taxa por distância.' };
  }
  let point = null;
  const addr = address || [customer?.address, customer?.neighborhood].filter(Boolean).join(', ');
  if (!address && customer?.latitude != null) point = { lat: customer.latitude, lng: customer.longitude };
  if (!point) {
    if (!addr) return { ok: false, error: 'Endereço do cliente ainda não informado.' };
    try {
      point = settings.store_city ? await geocode(`${addr}, ${settings.store_city}`) : null;
      if (!point) point = await geocode(addr);
    } catch {
      point = null;
    }
    if (!point) {
      return { ok: false, error: 'Não consegui localizar esse endereço no mapa. Peça para o cliente enviar a localização pelo WhatsApp (clipe → Localização).' };
    }
    if (customer?.id) {
      ctx.db.prepare("UPDATE customers SET latitude = ?, longitude = ?, location_source = 'endereco' WHERE id = ?").run(point.lat, point.lng, customer.id);
    }
  }
  const { km, method } = await distanceKm({ lat: settings.store_lat, lng: settings.store_lng }, point);
  const rule = feeForDistance(settings, km);
  return { ok: true, distance_km: Math.round(km * 10) / 10, distance_method: method, ...rule };
}
