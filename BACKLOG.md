# Backlog do Desenrola

Coisas combinadas pra fazer depois. A mais nova em cima.

## Textos das mensagens automáticas (templates do WhatsApp)
Revisar com calma os textos de todos os templates. A proposta ficou na conversa de 08/11/2026:
- tom gaúcho consistente ("tu", sem misturar com "te cadastraste");
- sem a frase "tu recebe esta mensagem porque…" (o botão "Parar de receber" já cumpre esse papel);
- nada de ponto duplo nas variáveis;
- cliente: "Chegou orçamento pro teu pedido …", "Um profissional tem uma dúvida sobre teu pedido …";
- profissional: convite, lembrete, resposta do cliente, aprovado (com "Boa notícia!"), encerrado.
Lembrar: o texto não pode começar nem terminar numa variável; só mandar pra revisão da Meta com o número oficial
(`npm run wa:templates -- submit`). Pro sandbox, `create` basta.

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
