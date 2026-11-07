# Desenrola

Agente que faz o meio de campo com prestadores de serviço pelo teu WhatsApp. Plano em [PLANO.md](PLANO.md), contrato da API em [API.md](API.md).

## Rodar

```bash
cp .env.example .env   # e coloque a ANTHROPIC_API_KEY
npm install
npm run dev            # servidor em :3333 + site em http://localhost:5173
```

Produção local: `npm run build && npm start` (o servidor serve o site em :3333).

## Testar sem incomodar ninguém

1. Ponha um segundo celular teu em `DEV_TEST_PROVIDER_PHONE` (ex.: `51999998888`). Ele aparece como "Prestador de teste" no topo da busca.
2. Sem `MP_ACCESS_TOKEN`, o Pix é simulado (botão "Simular pagamento").
3. Desmarque os prestadores reais na lista antes de clicar em "Chamar no WhatsApp", e deixe só o de teste.

## Avisos

- A conexão do WhatsApp é não oficial (aparelho vinculado) e pode levar a banimento do número. Use poucos contatos por pedido.
- A sessão fica em `data/wa-auth/`. Apague essa pasta (ou use "Desconectar") para desvincular.
- Ligações não são atendidas.
