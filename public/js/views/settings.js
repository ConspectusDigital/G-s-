import { api, attempt, confirmDialog, field, fmtMoney, h, modal, mount, toast } from '../lib.js';
import { loadProducts, loadTemplates, store } from '../store.js';

const SECTIONS = [
  ['whatsapp', 'WhatsApp'],
  ['ia', 'IA de atendimento'],
  ['entrega', 'Entrega'],
  ['lembretes', 'Lembretes'],
  ['produtos', 'Produtos e preços'],
  ['modelos', 'Mensagens prontas'],
  ['loja', 'Loja e atendimento'],
  ['usuarios', 'Usuários'],
];
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const KIND_LABEL = { lembrete: 'Lembrete de recompra', reconquista: 'Reconquista', entrega: 'Saiu para entrega', resposta: 'Resposta rápida' };

const input = (s, name, attrs = {}) => h('input', { name, value: s[name] ?? '', ...attrs });
const check = (s, name, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: Boolean(s[name]) }), label);

export function render(container, params) {
  let section = params[0] || 'whatsapp';
  let data;

  async function load() {
    data = await api('/api/settings');
    draw();
  }

  function settingsForm(children, extra) {
    const form = h('form', { onsubmit: (e) => e.preventDefault() }, children);
    const save = h('button', {
      class: 'btn primary',
      onclick: () => attempt(async () => {
        const v = {};
        for (const el of form.querySelectorAll('[name]')) {
          if (el.name === 'auto_send_days' || el.disabled) continue;
          v[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        }
        const days = form.querySelectorAll('[name=auto_send_days]');
        if (days.length) v.auto_send_days = [...days].filter((d) => d.checked).map((d) => Number(d.value));
        await api('/api/settings', { method: 'PUT', body: v });
        toast('Configurações salvas');
        await load();
        window.dispatchEvent(new Event('settings-changed'));
      }, save),
    }, 'Salvar');
    return h('div', {}, form, h('div', { class: 'btn-row' }, save, extra));
  }

  function draw() {
    const body = h('div');
    mount(container,
      h('div', { class: 'page-head' }, h('h1', {}, 'Configurações')),
      h('div', { class: 'tabs' }, SECTIONS.map(([k, l]) => h('button', { class: k === section ? 'active' : '', onclick: () => { section = k; location.hash = '#/config/' + k; } }, l))),
      body);
    ({ whatsapp, ia, entrega, lembretes, produtos, modelos, loja, usuarios })[section](body);
  }

  // ---------- WhatsApp ----------
  function whatsapp(el) {
    const s = data.settings;
    const statusBox = h('div', { class: 'card' }, h('span', { class: 'muted' }, 'Verificando conexão…'));
    const providerSel = h('select', { name: 'wa_provider', onchange: () => toggle() },
      h('option', { value: 'simulator', selected: s.wa_provider === 'simulator' }, 'Simulador (teste, sem WhatsApp real)'),
      h('option', { value: 'evolution', selected: s.wa_provider === 'evolution' }, 'Evolution API (WhatsApp comum via QR Code)'),
      h('option', { value: 'cloud', selected: s.wa_provider === 'cloud' }, 'WhatsApp Cloud API (oficial da Meta)'),
      h('option', { value: 'none', selected: s.wa_provider === 'none' }, 'Desativado'));

    const cloud = h('div', { class: 'card', 'data-p': 'cloud' },
      h('h3', {}, 'WhatsApp Cloud API (oficial)'),
      h('p', { class: 'small muted' }, 'Mais segura (sem risco de bloqueio), mas exige conta no Meta Business e um número dedicado. Mensagens iniciadas pela loja depois de 24h sem conversa só podem ser enviadas com um modelo aprovado pela Meta, e são cobradas por mensagem.'),
      h('div', { class: 'form-grid' },
        field('ID do número de telefone', input(s, 'cloud_phone_number_id')),
        field('Token de acesso permanente', input(s, 'cloud_token', { type: 'password', autocomplete: 'off' })),
        field('Chave secreta do app (App Secret)', input(s, 'cloud_app_secret', { type: 'password', autocomplete: 'off' }), 'Usada para conferir que o webhook veio mesmo da Meta.'),
        field('Versão da API', input(s, 'cloud_api_version')),
        field('Nome do modelo aprovado para lembretes', input(s, 'cloud_template_name', { placeholder: 'ex.: lembrete_gas' }), 'Usado quando já se passaram mais de 24h da última mensagem do cliente.'),
        field('Idioma do modelo', input(s, 'cloud_template_lang')),
        h('div', { class: 'full' }, field('Variáveis do modelo, em ordem', input(s, 'cloud_template_params'), 'Ex.: "nome,dias" preenche {{1}} com o nome e {{2}} com os dias desde a última compra. Disponíveis: nome, produto, dias, data_ultima, loja.'))),
      h('div', { class: 'small' },
        h('div', {}, h('strong', {}, 'URL do webhook (callback): '), h('code', {}, data.webhooks.cloud)),
        h('div', {}, h('strong', {}, 'Token de verificação: '), h('code', {}, s.cloud_verify_token)),
        h('div', { class: 'muted' }, 'No painel da Meta, assine o campo "messages" do webhook.')));

    const evo = h('div', { class: 'card', 'data-p': 'evolution' },
      h('h3', {}, 'Evolution API'),
      h('p', { class: 'small muted' }, 'Conecta o WhatsApp que a loja já usa, lendo um QR Code (como o WhatsApp Web). É gratuita e rápida de começar, mas não é oficial: evite disparos em massa para não ter o número bloqueado. Você precisa de um servidor com a Evolution API instalada (veja o README).'),
      h('div', { class: 'form-grid' },
        field('URL da Evolution API', input(s, 'evolution_url', { placeholder: 'https://evolution.seudominio.com.br' })),
        field('Nome da instância', input(s, 'evolution_instance', { placeholder: 'loja' })),
        field('API Key', input(s, 'evolution_apikey', { type: 'password', autocomplete: 'off' }))),
      h('div', { class: 'small' },
        h('div', {}, h('strong', {}, 'URL do webhook: '), h('code', { style: { wordBreak: 'break-all' } }, data.webhooks.evolution)),
        h('div', { class: 'muted' }, 'Na instância, ative o webhook com os eventos MESSAGES_UPSERT e MESSAGES_UPDATE.')));

    const sim = h('div', { class: 'card', 'data-p': 'simulator' },
      h('h3', {}, 'Modo simulador'),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Nenhuma mensagem sai de verdade. Use o botão "Simular" na tela de Atendimento para fingir que um cliente mandou mensagem e testar todo o fluxo.'));

    function toggle() {
      for (const c of [cloud, evo, sim]) c.classList.toggle('hidden', c.dataset.p !== providerSel.value);
    }

    mount(el, statusBox, h('div', { class: 'card' }, settingsForm([field('Como conectar o WhatsApp', providerSel), cloud, evo, sim])));
    toggle();

    api('/api/whatsapp/status').then((st) => {
      const qrBtn = st.provider === 'evolution' && !st.connected ? h('button', { class: 'btn wa', onclick: showQR }, 'Conectar (ler QR Code)') : null;
      mount(statusBox, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('span', { class: 'dot ' + (st.connected ? 'on' : 'off') }),
        h('strong', {}, st.connected ? 'Conectado' : 'Desconectado'),
        h('span', { class: 'muted small' }, `(${st.state})`),
        st.error ? h('span', { class: 'small', style: { color: 'var(--danger)' } }, st.error) : null,
        qrBtn));
    });
  }

  async function showQR() {
    const box = h('div', { style: { textAlign: 'center' } }, 'Gerando QR Code…');
    const m = modal({ title: 'Conectar WhatsApp', body: box });
    let timer;
    const refresh = async () => {
      try {
        const st = await api('/api/whatsapp/status');
        if (st.connected) { m.close(); toast('WhatsApp conectado!'); load(); return; }
        const qr = await api('/api/whatsapp/qrcode');
        mount(box,
          qr.base64 ? h('img', { src: qr.base64, alt: 'QR Code', style: { width: '260px', maxWidth: '100%' } }) : h('p', {}, 'QR Code indisponível.'),
          qr.pairingCode ? h('p', {}, 'Ou use o código: ', h('strong', {}, qr.pairingCode)) : null,
          h('p', { class: 'small muted' }, 'No celular da loja: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho.'));
      } catch (err) {
        mount(box, h('p', { style: { color: 'var(--danger)' } }, err.message));
      }
    };
    await refresh();
    timer = setInterval(() => { if (!document.body.contains(m.el)) clearInterval(timer); else refresh(); }, 20000);
  }

  // ---------- IA de atendimento ----------
  function ia(el) {
    const s = data.settings;
    const testBtn = h('button', {
      class: 'btn',
      onclick: () => attempt(async () => {
        const r = await api('/api/ai/test', { method: 'POST' });
        toast('IA respondeu: ' + r.text);
      }, testBtn),
    }, 'Testar conexão com a IA');
    mount(el,
      h('div', { class: 'card' },
        h('h2', {}, 'Atendente virtual no WhatsApp'),
        h('p', { class: 'small muted', style: { marginTop: 0 } },
          'A IA responde os clientes de forma simpática, cadastra nome e endereço de quem é novo, calcula a taxa de entrega, confirma e registra o pedido. ',
          'Quando o cliente pede uma pessoa, reclama ou pede algo fora do padrão, ela chama você e para de responder naquela conversa. ',
          'Em cada conversa da tela de Atendimento há o botão "Assumir conversa" para desligar a IA só ali.'),
        settingsForm([
          check(s, 'ai_enabled', 'Ligar a IA de atendimento'),
          check(s, 'ai_pause_on_human', 'Quando alguém da loja responder numa conversa, a IA para de atender ali'),
          h('div', { class: 'form-grid' },
            field('Nome da atendente', input(s, 'ai_name'), 'Como a IA se apresenta. Ex.: Bia, Ana, Gabi.'),
            field('Chave da API (Anthropic)', input(s, 'ai_api_key', { type: 'password', autocomplete: 'off', placeholder: 'sk-ant-...' }), 'Crie em console.anthropic.com → API Keys.'),
            field('Modelo', h('select', { name: 'ai_model' },
              [['claude-opus-5-5', 'Claude Opus 5.5 (recomendado)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (mais barato)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (o mais barato)']]
                .map(([v, l]) => h('option', { value: v, selected: s.ai_model === v }, l)))),
            field('Capricho nas respostas', h('select', { name: 'ai_effort' },
              [['low', 'Rápido e econômico (recomendado)'], ['medium', 'Equilibrado'], ['high', 'Mais cuidadoso (mais caro)']]
                .map(([v, l]) => h('option', { value: v, selected: s.ai_effort === v }, l)))),
            field('Esperar antes de responder (segundos)', input(s, 'ai_wait_seconds', { type: 'number', min: 0, max: 60 }), 'O cliente costuma mandar várias mensagens seguidas; a IA espera para ler tudo junto.'),
            field('Formas de pagamento aceitas', input(s, 'payment_methods'))),
          field('Mensagem ao passar para um humano', h('textarea', { name: 'ai_handoff_message', rows: 2 }, s.ai_handoff_message)),
          field('Instruções extras para a IA', h('textarea', { name: 'ai_instructions', rows: 5, placeholder: 'Ex.: Aceitamos vale-gás do governo. Domingo abrimos só até 12h. Não entregamos no bairro X. O botijão vazio precisa ser trocado na entrega.' }, s.ai_instructions),
            'Escreva em linguagem normal o que a IA precisa saber sobre a loja.'),
        ], testBtn)),
      h('div', { class: 'card small muted' },
        h('strong', {}, 'Custos: '), 'a IA é cobrada pela Anthropic conforme o uso. Um atendimento completo costuma custar alguns centavos de real. ',
        'Os modelos Sonnet e Haiku são mais baratos; o Opus é o mais caprichado. Acompanhe o gasto em console.anthropic.com.'));
  }

  // ---------- Entrega ----------
  function entrega(el) {
    const s = data.settings;
    const modeSel = h('select', { name: 'delivery_fee_mode', onchange: () => toggle() },
      [['gratis', 'Entrega grátis sempre'], ['fixa', 'Taxa fixa para todos'], ['por_distancia', 'Por distância (grátis até X km)']]
        .map(([v, l]) => h('option', { value: v, selected: s.delivery_fee_mode === v }, l)));
    const fixedBox = h('div', {}, field('Valor da taxa (R$)', input(s, 'delivery_fee_fixed', { type: 'number', step: '0.01', min: 0 })));
    const coords = s.store_lat != null ? `${s.store_lat}, ${s.store_lng}` : '';
    const locateBtn = h('button', {
      class: 'btn sm', type: 'button',
      onclick: () => attempt(async () => {
        const p = await api('/api/delivery/locate-store', { method: 'POST' });
        toast('Loja localizada no mapa!');
        el.querySelector('[name=store_coords]').value = `${p.lat}, ${p.lng}`;
      }, locateBtn),
    }, 'Localizar pelo endereço');
    const distBox = h('div', {},
      h('div', { class: 'form-grid' },
        field('Grátis até (km)', input(s, 'delivery_free_km', { type: 'number', step: '0.1', min: 0 })),
        field('Taxa acima disso (R$)', input(s, 'delivery_fee_fixed', { type: 'number', step: '0.01', min: 0 })),
        field('+ por km excedente (R$)', input(s, 'delivery_fee_per_km', { type: 'number', step: '0.01', min: 0 }), 'Deixe 0 para cobrar só a taxa acima.'),
        field('Não entregar acima de (km)', input(s, 'delivery_max_km', { type: 'number', step: '0.1', min: 0 }), '0 = sem limite.'),
        field('Endereço da loja', input(s, 'store_address', { placeholder: 'Rua, número, bairro' })),
        field('Cidade - UF', input(s, 'store_city', { placeholder: 'ex.: Campinas - SP' })),
        h('div', { class: 'full' }, field('Localização da loja (latitude, longitude)', h('div', { style: { display: 'flex', gap: '8px' } },
          h('input', { name: 'store_coords', value: coords, placeholder: '-23.5505, -46.6333' }), locateBtn),
        'No Google Maps, clique com o botão direito em cima da loja e clique nos números para copiar. Ou salve o endereço acima e use "Localizar pelo endereço".'))),
      h('p', { class: 'small muted', style: { margin: '0 0 12px' } }, 'A distância é calculada pelo caminho de carro (OpenStreetMap). Se o endereço do cliente não for encontrado, a IA pede para ele mandar a localização pelo WhatsApp.'));
    function toggle() {
      fixedBox.classList.toggle('hidden', modeSel.value !== 'fixa');
      distBox.classList.toggle('hidden', modeSel.value !== 'por_distancia');
      // Os dois blocos têm o campo de taxa; só o visível é enviado.
      for (const inp of el.querySelectorAll('[name=delivery_fee_fixed]')) inp.disabled = inp.closest('.hidden') !== null;
    }

    const quoteAddr = h('input', { placeholder: 'Endereço de um cliente, ex.: Rua das Flores, 100, Centro' });
    const quoteOut = h('div', { class: 'small', style: { marginTop: '8px' } });
    const quoteBtn = h('button', {
      class: 'btn',
      onclick: () => attempt(async () => {
        const r = await api('/api/delivery/quote', { method: 'POST', body: { address: quoteAddr.value } });
        mount(quoteOut, !r.ok ? h('span', { style: { color: 'var(--danger)' } }, r.error)
          : r.outOfRange ? `Fora da área de entrega (${r.distance_km} km)`
            : `Taxa: R$ ${Number(r.fee).toFixed(2).replace('.', ',')}${r.distance_km != null ? ` · ${r.distance_km} km (${r.distance_method})` : ''} · ${r.rule}`);
      }, quoteBtn),
    }, 'Calcular');

    mount(el,
      h('div', { class: 'card' }, h('h2', {}, 'Taxa de entrega'),
        settingsForm([
          field('Como cobrar a entrega', modeSel),
          fixedBox, distBox,
          field('Previsão de entrega', input(s, 'delivery_eta'), 'A IA informa isso ao cliente. Ex.: 30 a 60 minutos.'),
        ])),
      h('div', { class: 'card' }, h('h2', {}, 'Simular taxa'),
        h('div', { style: { display: 'flex', gap: '8px' } }, quoteAddr, quoteBtn), quoteOut));
    toggle();
  }

  // ---------- Lembretes ----------
  function lembretes(el) {
    const s = data.settings;
    const num = (name, min = 0) => input(s, name, { type: 'number', min });
    mount(el,
      h('div', { class: 'card' },
        h('h2', {}, 'Como o sistema decide quem chamar'),
        h('p', { class: 'small muted', style: { marginTop: 0 } },
          'Cada produto tem uma duração padrão (ex.: P13 = 45 dias). Depois que o cliente compra 2 vezes ou mais, o sistema passa a usar o intervalo real dele. Um aviso aparece alguns dias ', h('em', {}, 'antes'), ' do gás acabar, para você chamar o cliente antes que ele compre de outro.'),
        settingsForm(h('div', { class: 'form-grid' },
          field('Avisar quantos dias antes de acabar', num('lead_days'), 'Ex.: 5 → um P13 de 45 dias aparece em "Chamar" no 40º dia.'),
          field('Chamar de novo após (dias sem resposta)', num('recontact_days', 1), 'Se você chamou e o cliente não comprou, ele volta para a lista depois desses dias.'),
          field('Considerar "sumido" após atraso de (dias)', num('inactive_grace_days', 1), 'Quantos dias depois da data prevista o cliente vai para "Reconquistar".'),
          field('Contar venda como "após lembrete" até (dias)', num('conversion_window_days', 1), 'Usado no painel para medir o resultado dos lembretes.')))),
      h('div', { class: 'card' },
        h('h2', {}, 'Envio automático'),
        h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Quando ligado, o sistema manda sozinho a mensagem de lembrete para quem está em "Chamar agora", dentro do horário escolhido, uma de cada vez e com intervalo. Recomendado começar desligado e enviar manualmente nas primeiras semanas.'),
        settingsForm([
          check(s, 'auto_send', 'Ligar envio automático de lembretes'),
          check(s, 'auto_send_include_inactive', 'Incluir clientes sumidos (mensagem de reconquista)'),
          h('div', { class: 'form-grid' },
            field('Começar às', input(s, 'auto_send_start', { type: 'time' })),
            field('Parar às', input(s, 'auto_send_end', { type: 'time' })),
            field('Máximo de mensagens por dia', num('auto_send_daily_limit')),
            field('Máximo de tentativas automáticas por cliente', num('auto_send_max_attempts', 1), 'Depois disso o cliente fica só para contato manual (ligação).'),
            field('Intervalo mínimo entre mensagens (seg.)', num('send_delay_min', 5)),
            field('Intervalo máximo entre mensagens (seg.)', num('send_delay_max', 5))),
          h('div', { class: 'field' }, h('span', { style: { display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, 'Dias da semana'),
            h('div', { class: 'btn-row' }, WEEKDAYS.map((d, i) => h('label', { class: 'check', style: { marginRight: '8px' } },
              h('input', { type: 'checkbox', name: 'auto_send_days', value: i, checked: s.auto_send_days.includes(i) }), d)))),
        ])));
  }

  // ---------- Loja ----------
  function loja(el) {
    const s = data.settings;
    mount(el, h('div', { class: 'card' }, settingsForm([
      h('div', { class: 'form-grid' },
        field('Nome da loja', input(s, 'store_name'), 'Aparece nas mensagens como {loja}.'),
        field('DDD padrão', input(s, 'default_ddd', { placeholder: 'ex.: 11', maxlength: 2 }), 'Usado quando o telefone é digitado sem DDD.'),
        field('Abre às', input(s, 'business_hours_start', { type: 'time' })),
        field('Fecha às', input(s, 'business_hours_end', { type: 'time' })),
        field('Fuso horário', input(s, 'timezone'), 'Ex.: America/Sao_Paulo, America/Manaus, America/Recife.')),
      check(s, 'away_enabled', 'Responder automaticamente fora do horário'),
      field('Mensagem fora do horário', h('textarea', { name: 'away_message', rows: 3 }, s.away_message)),
      check(s, 'notify_on_dispatch', 'Avisar o cliente pelo WhatsApp quando o pedido sair para entrega'),
      field('Palavras para parar de receber lembretes', input(s, 'opt_out_keywords'), 'Se o cliente responder exatamente uma dessas palavras, ele é marcado como "não contatar".'),
    ])));
  }

  // ---------- Produtos ----------
  async function produtos(el) {
    const products = await loadProducts();
    const editRow = (p = {}) => {
      const form = h('form', { onsubmit: (e) => e.preventDefault() }, h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Nome', h('input', { name: 'name', value: p.name || '' }))),
        field('Preço (R$)', h('input', { name: 'price', type: 'number', step: '0.01', min: 0, value: p.price ?? '' })),
        field('Dura em média (dias)', h('input', { name: 'cycle_days', type: 'number', min: 3, max: 365, value: p.cycle_days ?? '' }), 'Deixe vazio para produtos sem lembrete de recompra (ex.: vasilhame).')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p.active !== 0 }), 'Ativo (aparece nos pedidos)'));
      const save = h('button', {
        class: 'btn primary',
        onclick: () => attempt(async () => {
          const v = Object.fromEntries(new FormData(form));
          v.active = form.querySelector('[name=active]').checked;
          await api('/api/products' + (p.id ? '/' + p.id : ''), { method: p.id ? 'PUT' : 'POST', body: v });
          m.close();
          produtos(el);
        }, save),
      }, 'Salvar');
      const m = modal({ title: p.id ? 'Editar produto' : 'Novo produto', body: form, footer: [save] });
    };
    mount(el, h('div', { class: 'card', style: { padding: 0 } },
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ['Produto', 'Preço', 'Dura em média', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, products.map((p) => h('tr', { class: 'clickable', onclick: () => editRow(p) },
          h('td', {}, p.name, p.active ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'inativo')),
          h('td', {}, fmtMoney(p.price)),
          h('td', {}, p.cycle_days ? p.cycle_days + ' dias' : h('span', { class: 'muted' }, 'sem lembrete')),
          h('td', { style: { textAlign: 'right' } }, h('span', { class: 'small muted' }, 'editar'))))))),
      h('div', { style: { padding: '12px' } }, h('button', { class: 'btn', onclick: () => editRow() }, '+ Novo produto'))));
  }

  // ---------- Modelos ----------
  async function modelos(el) {
    const templates = await loadTemplates();
    const edit = (t = { kind: 'resposta' }) => {
      const form = h('form', { onsubmit: (e) => e.preventDefault() },
        h('div', { class: 'form-grid' },
          field('Nome', h('input', { name: 'name', value: t.name || '' })),
          field('Tipo', h('select', { name: 'kind' }, Object.entries(KIND_LABEL).map(([k, v]) => h('option', { value: k, selected: k === t.kind }, v))))),
        field('Texto', h('textarea', { name: 'body', rows: 7 }, t.body || ''),
          'Variáveis: {nome} primeiro nome, {nome_completo}, {produto}, {dias} desde a última compra, {data_ultima}, {loja}.'));
      const save = h('button', {
        class: 'btn primary',
        onclick: () => attempt(async () => {
          await api('/api/templates' + (t.id ? '/' + t.id : ''), { method: t.id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
          m.close();
          modelos(el);
        }, save),
      }, 'Salvar');
      const del = t.id ? h('button', {
        class: 'btn ghost danger',
        onclick: async () => {
          if (!(await confirmDialog('Excluir este modelo?', { ok: 'Excluir', danger: true }))) return;
          await attempt(async () => { await api('/api/templates/' + t.id, { method: 'DELETE' }); m.close(); modelos(el); });
        },
      }, 'Excluir') : null;
      const m = modal({ title: t.id ? 'Editar mensagem' : 'Nova mensagem', body: form, wide: true, footer: [del, save] });
    };
    mount(el,
      h('p', { class: 'small muted', style: { marginTop: 0 } }, 'O primeiro modelo do tipo "Lembrete de recompra" é usado nos lembretes; o de "Reconquista", para clientes sumidos. Os de "Resposta rápida" aparecem no botão ⚡ do atendimento.'),
      h('div', { class: 'rem-list' }, templates.map((t) => h('div', { class: 'card', style: { cursor: 'pointer', margin: 0 }, onclick: () => edit(t) },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } }, h('strong', {}, t.name), h('span', { class: 'badge' }, KIND_LABEL[t.kind] || t.kind)),
        h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, t.body)))),
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => edit() }, '+ Nova mensagem')));
  }

  // ---------- Usuários ----------
  async function usuarios(el) {
    const users = await api('/api/users');
    const add = () => {
      const form = h('form', { onsubmit: (e) => e.preventDefault() },
        field('Nome', h('input', { name: 'name' })), field('Usuário (login)', h('input', { name: 'username', autocapitalize: 'off' })),
        field('Senha', h('input', { name: 'password', type: 'password' })));
      const save = h('button', {
        class: 'btn primary',
        onclick: () => attempt(async () => { await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); m.close(); usuarios(el); }, save),
      }, 'Criar');
      const m = modal({ title: 'Novo usuário', body: form, footer: [save] });
    };
    const pw = h('form', { onsubmit: (e) => e.preventDefault() }, h('div', { class: 'form-grid' },
      field('Senha atual', h('input', { name: 'current', type: 'password' })), field('Nova senha', h('input', { name: 'password', type: 'password' }))));
    const pwBtn = h('button', {
      class: 'btn',
      onclick: () => attempt(async () => { await api('/api/password', { method: 'POST', body: Object.fromEntries(new FormData(pw)) }); pw.reset(); toast('Senha alterada'); }, pwBtn),
    }, 'Alterar minha senha');
    mount(el,
      h('div', { class: 'card', style: { padding: 0 } }, h('table', { class: 'list' }, h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.username)),
        h('td', { style: { textAlign: 'right' } }, u.id === store.me?.id ? h('span', { class: 'small muted' }, 'você') : h('button', {
          class: 'btn sm ghost danger',
          onclick: async () => { if (await confirmDialog(`Remover o acesso de ${u.name}?`, { ok: 'Remover', danger: true })) attempt(async () => { await api('/api/users/' + u.id, { method: 'DELETE' }); usuarios(el); }); },
        }, 'Remover')))))),
        h('div', { style: { padding: '12px' } }, h('button', { class: 'btn', onclick: add }, '+ Novo usuário'))),
      h('div', { class: 'card' }, h('h2', {}, 'Minha senha'), pw, pwBtn));
  }

  load();
  return { update: (p) => { section = p[0] || 'whatsapp'; if (data) draw(); } };
}
