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
- **Deploy:** `render.yaml` (Blueprint). O site fica atrás de `SITE_PASSWORD` até existir login.

## Testar sem incomodar ninguém

1. Ponha um segundo celular teu em `DEV_TEST_PROVIDER_PHONE` (ex.: `51999998888`). Ele aparece como "Prestador de teste" no topo da busca.
2. Sem `MP_ACCESS_TOKEN`, o Pix é simulado (botão "Simular pagamento").
3. Desmarque os prestadores reais na lista antes de clicar em "Chamar no WhatsApp", e deixe só o de teste.

## Avisos

- A conexão do WhatsApp é não oficial (aparelho vinculado) e pode levar a banimento do número. Use poucos contatos por pedido.
- A sessão fica em `data/wa-auth/`. Apague essa pasta (ou use "Desconectar") para desvincular.
- Ligações não são atendidas.
