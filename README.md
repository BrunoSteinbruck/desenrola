# Desenrola

Agente que pega orçamentos com prestadores de serviço pra ti.

- **V2 (em construção, `main`):** marketplace com banco próprio de prestadores; o Desenrola fala com eles por um número oficial (WhatsApp Business via Twilio). Plano em [PLANO-V2.md](PLANO-V2.md).
- **V1 (branch `v1`):** o agente falava pelo WhatsApp do próprio usuário (QR). Plano em [PLANO.md](PLANO.md), API em [API.md](API.md).

## Rodar

```bash
cp .env.example .env   # e coloque a ANTHROPIC_API_KEY
npm install
npm run dev            # servidor em :3333 + site em http://localhost:5173
```

Produção local: `npm run build && npm start` (o servidor serve o site em :3333).
Testes: `npm test`.

## WhatsApp oficial (V2)

Código em `server/src/channel/`: adaptador Twilio (ou stub), webhook `POST /webhooks/whatsapp` com assinatura conferida,
entrada durável, fila de saída com retry, janela de 24h e opt-in/opt-out.

- **Sem credencial da Twilio** o canal é um stub: nada sai, só aparece no log. Simule o prestador respondendo:
  `curl -X POST localhost:3333/api/dev/whatsapp/inbound -H 'content-type: application/json' -d '{"from":"5551999990000","text":"oi"}'`
  e veja a fila em `GET /api/dev/whatsapp/outbox`.
- **Sandbox da Twilio** (antes da aprovação da Meta): `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`; o webhook precisa de URL pública
  (deploy no Render ou um túnel) e `WHATSAPP_WEBHOOK_URL` igual à cadastrada no sandbox.
- **Templates:** o texto fica em `server/src/channel/templates.ts`. `npm run wa:templates` mostra; `-- submit` manda pra aprovação; `-- status` acompanha.
  Os SIDs aprovados vão em `WA_TPL_*`.
- **Deploy:** `render.yaml` (Blueprint). `ADMIN_PASSWORD` é obrigatória; `SITE_PASSWORD` (opcional) esconde o site antes do lançamento.

## Como funciona a V2

0. **Sem login pra começar:** quem chega vira visitante (cookie) e já conversa com o diagnóstico.
   O celular só é pedido em "Pedir orçamentos" (código no WhatsApp, template `codigo_verificacao`; sem Twilio aparece na tela),
   e os pedidos do visitante passam pra conta. Cada cliente só vê os próprios pedidos (rotas e tempo real).
   O primeiro cliente de verdade herda os pedidos da época de usuário único.
1. **Admin** em `/admin` (senha `ADMIN_PASSWORD`; em dev qualquer senha): cadastra o profissional (nome, celular, categorias, bairros).
   Sai o template `boas_vindas`; só quando ele toca em **"Sim, quero receber"** vira ativo (a prova do opt-in fica guardada).
2. **Cliente** descreve o problema no site → diagnóstico → "Ver eletricista da região" (matching no nosso banco, não manda nada) →
   "Pedir orçamentos" (template `pedido_novo` pros selecionados).
3. O profissional toca em **"Ver detalhes"** e o agente do Desenrola negocia (uma negociação por profissional; os outros pedidos dele esperam na fila).
4. O cliente **aprova** → o profissional recebe nome, celular e bairro do cliente (`orcamento_aprovado`) e os outros recebem `pedido_encerrado`.
5. Se o profissional pedir uma pessoa ou sair do assunto, a conversa vai pro **inbox do admin** (aba Conversas).
6. **Sem profissional na região:** o cliente vê contatos sugeridos (busca na internet guardada no banco; quem chama é o cliente, por `wa.me`).
   Esses contatos viram leads na aba **Recrutamento** do admin: onde falta profissional, quem os clientes mais quiseram chamar,
   convite pronto pra copiar e "Cadastrar" (vira profissional e recebe o pedido de confirmação).
7. **Autocadastro** em `/profissional`: o profissional diz o que faz e onde atende, confirma o celular por código no WhatsApp
   e marca o aceite (opt-in). Já entra ativo. O convite do recrutamento leva esse link.

## Testar sem incomodar ninguém

- Sem credencial da Twilio nada sai (stub). Cadastre um número de teste no `/admin` e simule as respostas dele com
  `POST /api/dev/whatsapp/inbound` (o `repliedToMsgId` de um clique vem de `GET /api/dev/whatsapp/outbox`).
- Prestadores achados por busca (os da V1) ficam como **lead** e nunca recebem mensagem.

## Avisos

- A V2 não usa mais o WhatsApp do usuário. A sessão antiga da V1 continua em `data/wa-auth/` (serve pra branch `v1`); a V2 não mexe nela.
- Ligações não são atendidas.
