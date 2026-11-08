# Backlog do Desenrola

Coisas combinadas pra fazer depois. A mais nova em cima.

## Avaliação pelo WhatsApp
O template `cliente_avaliacao` (com Ótimo/Razoável/Ruim) existe, mas o pós-serviço ainda só pergunta no site.
Ligar o envio e tratar os botões.

## Tempo do lembrete
O lembrete pro profissional sai depois de 3h. Rever: cliente dificilmente espera tanto.

## Deploy sem perder mensagem
Cada deploy derruba o site por 30–60 s (disco persistente = sem troca sem parada) e o WhatsApp que chega nesse
tempo se perde (Twilio dá erro 11200 e não tenta de novo).
- Render: não fazer deploy quando só muda script/doc (`buildFilter` no `render.yaml`).
- Twilio: configurar uma URL reserva (fallback) ou fila, pra não perder mensagem durante o deploy.
- Mais pra frente: Postgres gerenciado, que permite atualizar sem parar.

## Número oficial do WhatsApp
Portfólio no Meta Business (conta de outra pessoa + CNPJ), chip novo, remetente oficial no Twilio,
templates aprovados. Trocar `TWILIO_WHATSAPP_FROM` e os `WA_TPL_*` no Render.

## Outros
- Restringir a chave do Google Maps só à Places API (New).
- Backup diário do banco pro R2.
- Página de privacidade (LGPD) e "apagar meus dados".
- Fotos do problema (cliente e profissional).
- Cobrança do profissional (F6), quando houver demanda.
- Logo definitivo (com a sessão de design).
