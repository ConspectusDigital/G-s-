# 🔥 Gás Atendimento

Sistema de atendimento por WhatsApp para revenda de gás (e água), com **lembretes de recompra**:
ele calcula quando o botijão de cada cliente deve acabar e avisa a loja para chamar o cliente
**antes** que ele compre de outro lugar.

## O que o sistema faz

| Tela | Para que serve |
|---|---|
| **Painel** | Vendas do dia e do mês, quantos clientes chamar hoje, faturamento dos últimos 30 dias e quanto foi vendido depois de um lembrete. |
| **Chamar** | Lista de quem está com o gás acabando, com botões para mandar WhatsApp, ligar, adiar ou registrar a venda. |
| **Atendimento** | Caixa de entrada do WhatsApp: conversas em tempo real, respostas prontas (⚡) e botão de “+ Pedido” direto da conversa. |
| **Pedidos** | Pedidos do dia, situação da entrega (novo → saiu → entregue), forma de pagamento e totais. |
| **Clientes** | Cadastro com endereço e ponto de referência, histórico de compras e de contatos, importação/exportação de planilha. |
| **Config.** | Conexão do WhatsApp, regras dos lembretes, envio automático, produtos e preços, mensagens prontas e usuários. |

### Como o lembrete funciona

1. Cada produto tem uma **duração média** (P13 = 45 dias, P45 = 60, água 20 L = 10; tudo editável).
2. Quando o cliente compra **2 vezes ou mais**, o sistema passa a usar o **ritmo real daquele cliente**
   (mediana dos intervalos entre compras, considerando quantos botijões ele levou). Isso importa porque
   um P13 pode durar de ~25 a ~90 dias dependendo da casa.
3. Alguns dias **antes** da data prevista (padrão: 5), o cliente aparece em **“Chamar agora”**.
4. Depois de chamado, ele vai para **“Aguardando”**. Se não comprar em 7 dias, volta para a lista.
   Se disser “me chama semana que vem”, use **Adiar**.
5. Se passar muito do prazo (padrão: 45 dias de atraso), vai para **“Reconquistar”** — provavelmente
   está comprando de outro lugar e merece uma mensagem diferente.
6. O painel mostra **quantas vendas aconteceram até 7 dias depois de um lembrete**, para medir o resultado.

Também dá para definir manualmente o ciclo de um cliente (“esse aqui troca a cada 30 dias”) na ficha dele.

Outros detalhes:
- Se o cliente responder **SAIR**, ele é marcado como “não contatar” automaticamente.
- Clientes novos que mandam mensagem no WhatsApp são cadastrados sozinhos.
- Localização enviada pelo WhatsApp vira link do Google Maps.
- Opção de responder automaticamente fora do horário e de avisar “seu pedido saiu para entrega”.
- Envio automático de lembretes (opcional), com limite diário, horário e intervalo entre mensagens.

## 🤖 IA de atendimento

Uma atendente virtual (nome configurável, padrão "Bia") responde o WhatsApp de forma simpática e natural, usando o
Claude, a IA da Anthropic:

- **Cliente novo:** pergunta nome e endereço (rua, número, bairro e ponto de referência) e **cadastra sozinha**.
  O telefone vem da própria conversa.
- **Cliente antigo:** reconhece pelo telefone e já sabe o nome, endereço e últimas compras ("Vai ser o P13 de sempre?").
- **Taxa de entrega:** calcula pela regra configurada (grátis, fixa, ou grátis até X km e cobrada acima disso).
- **Pedido:** confirma itens, endereço, pagamento, troco e total com o cliente e **registra o pedido** na tela de Pedidos.
- **Chama um humano** quando o cliente pede, reclama, fala de vazamento, pede fiado/desconto ou quer mudar um pedido.
  A conversa fica marcada com **⚠️ Precisa de você** e você recebe um aviso.
- **Liga/desliga por conversa:** em cada chat há o botão **✋ Assumir conversa** (a IA para ali) e **🤖 Devolver para a IA**.
  Se alguém da loja responder pelo sistema ou pelo celular, a IA também para naquela conversa (dá para desativar isso).

Para ativar: **Config. → IA de atendimento**, cole a chave da API (crie em [console.anthropic.com](https://console.anthropic.com)),
marque "Ligar a IA" e salve. Configure também **Config. → Entrega**. A IA é cobrada pela Anthropic conforme o uso
(normalmente centavos por atendimento).

### Taxa de entrega por distância

Informe a localização da loja (copie as coordenadas do Google Maps ou use "Localizar pelo endereço"). O sistema
encontra o endereço do cliente no mapa (OpenStreetMap) e calcula a distância de carro. Se não achar o endereço,
a IA pede para o cliente mandar a **localização pelo WhatsApp**, que tem as coordenadas exatas.

## Como rodar

Precisa do **Node.js 22.13 ou mais novo**.

```bash
npm install
npm start
# abra http://localhost:3000
```

No primeiro acesso, o sistema pede para criar o usuário administrador.
Os dados ficam no arquivo `data/gas.db` — **faça cópia de segurança dele** (ex.: diariamente para o Google Drive).

### Quer ver funcionando com dados de exemplo?

```bash
npm run demo        # cria data/demo.db com 60 clientes fictícios
npm run start:demo  # login: admin / admin123
```

Ele começa no **modo simulador**: nenhuma mensagem sai de verdade, e o botão “Simular” do Atendimento
finge que um cliente mandou mensagem.

### Começando com os clientes que a loja já tem

Em **Clientes → Importar planilha**, envie um CSV (do Excel ou Google Planilhas) com as colunas:
`nome, telefone, endereco, bairro, referencia, observacoes, ultima_compra, produto, quantidade`.
Só `nome` é obrigatória, mas **`ultima_compra` (dd/mm/aaaa) é o que faz os lembretes funcionarem desde o primeiro dia**.
Se não houver planilha, vá cadastrando no dia a dia: ao criar o cliente, preencha “Última compra”.

## Conectando o WhatsApp

Há duas opções em **Config. → WhatsApp**:

### Opção A — Evolution API (mais rápida para começar)
Conecta o **mesmo WhatsApp que a loja já usa** lendo um QR Code, como o WhatsApp Web.
É gratuita, mas **não é oficial**: o WhatsApp pode bloquear números que mandam muitas mensagens
para quem não tem o número salvo. Por isso o sistema envia uma mensagem de cada vez, com intervalo,
e limita a quantidade por dia. Recomendações: comece enviando manualmente, poucas mensagens por dia,
só para clientes que já compraram, e sempre com a opção de responder SAIR.

1. Instale a [Evolution API](https://doc.evolution-api.com) num servidor (VPS) e crie uma instância.
2. No sistema, preencha URL, nome da instância e API Key.
3. Na instância da Evolution, configure o **webhook** com a URL mostrada na tela de configuração,
   com os eventos `MESSAGES_UPSERT` e `MESSAGES_UPDATE`.
4. Clique em **Conectar (ler QR Code)** e leia com o celular da loja.

### Opção B — WhatsApp Cloud API (oficial da Meta)
Sem risco de bloqueio e mais profissional, mas exige conta no **Meta Business**, um número dedicado e tem custo:
mensagens que a loja inicia (como o lembrete) precisam usar um **modelo aprovado pela Meta** e são cobradas por
mensagem entregue. Responder o cliente dentro de 24h após a mensagem dele é texto livre.
Confira os preços atuais na [tabela oficial](https://developers.facebook.com/docs/whatsapp/pricing).

1. Crie um app em developers.facebook.com com o produto WhatsApp e gere um token permanente.
2. Preencha “ID do número de telefone”, token e App Secret.
3. Cadastre o webhook com a URL e o token de verificação mostrados na tela, assinando o campo `messages`.
4. Crie e aprove um modelo de lembrete (categoria *Marketing*), ex.:
   `Olá, {{1}}! Sua última compra de gás foi há {{2}} dias. Quer que a gente leve um botijão pra você?`
   e informe o nome dele em “Nome do modelo aprovado para lembretes” com as variáveis `nome,dias`.

## Colocando no ar

Para o WhatsApp conseguir mandar mensagens para o sistema, ele precisa estar num endereço acessível pela
internet com **HTTPS** — por exemplo, uma VPS barata com Docker e um proxy (Caddy/Nginx) com certificado:

```bash
docker compose up -d --build
```

Os dados ficam na pasta `./data` do servidor. O sistema funciona no celular (o menu vai para a parte de baixo
da tela); dá para “Adicionar à tela inicial” no navegador.

## Estrutura do código

```
src/
  server.js              inicia o servidor
  app.js                 rotas, autenticação e eventos em tempo real
  db.js                  banco SQLite (embutido no Node), tabelas e configurações padrão
  services/reminders.js  ★ cálculo de quando o produto acaba e quem chamar
  services/messages.js   envio/recebimento de mensagens, cadastro automático, SAIR
  services/autosend.js   fila de envio com intervalo e envio automático agendado
  services/ai.js         ★ IA de atendimento: instruções, ferramentas e controle por conversa
  services/delivery.js   localização no mapa, distância e taxa de entrega
  whatsapp/              conectores: Cloud API, Evolution API e simulador
  routes/                API REST
public/                  interface (HTML/CSS/JS puro, sem build)
test/                    testes (npm test)
```
