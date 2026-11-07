# Desenrola V2 — Plano (marketplace com número próprio)

> A V1 (branch `v1`) falava com prestadores **pelo WhatsApp do próprio usuário** (Baileys + QR).
> A V2 segue o modelo GetNinjas: **banco próprio de prestadores**, e quem fala com eles é **um número oficial do Desenrola**, pela API oficial do WhatsApp. O cliente nunca conecta o WhatsApp dele.
> Revisado pelo Fable (§11) e cruzado com o que o Convivar já tem de Twilio (§10).

## 0. Decisões que mudam tudo

| Tema | V1 | V2 |
|---|---|---|
| Canal com prestador | WhatsApp do usuário (Baileys) | Número do Desenrola na WhatsApp Business Platform, atrás de um adaptador (Twilio primeiro, Meta Cloud API depois se compensar) |
| Quem o agente "é" | Fingia ser o próprio usuário | **É o Desenrola**, um serviço que pede orçamento em nome de um cliente. Honesto, sem imitar ninguém. Com um humano (Bruno) que assume quando precisa |
| Origem dos prestadores | Google na hora, para cada pedido | **Cadastrados com opt-in explícito**. Google e indicações servem pra *recrutar*, nunca pra disparar mensagem |
| Quem paga | Cliente (Pix por pedido, desligado) | **Prestador**, cobrado **quando o cliente aprova o orçamento dele** (é quando o contato é liberado). Grátis no começo |
| Usuários | Um só, local, sem login | Vários clientes, logados por código no WhatsApp. **Toda rota e o SSE checam o dono** |
| Onde roda | Mac do Bruno | Render, instância paga, **1 réplica fixa** (scheduler e locks em memória) |

**Regra de ouro (política do WhatsApp):** só mandamos mensagem pra quem disse explicitamente que quer receber, e guardamos a resposta literal como prova. Disparar pra quem não pediu derruba a qualidade do número e pode banir a conta.

## 1. Pré-requisito fora do código (caminho crítico)

O WhatsApp oficial **começa do zero**. O Convivar nunca ativou o dele: o Facebook pessoal do Bruno tem restrição de publicidade e não consegue criar portfólio empresarial.
1. **Portfólio no Meta Business do Desenrola**, criado por uma pessoa sem restrição (sócio?), com **CNPJ** pra verificação.
   - Sem verificação, o limite é de 250 destinatários novos por dia.
   - Verificado, sobe pra 2.000 e depois escala sozinho.
2. **Número dedicado à plataforma**, que nunca tenha sido usado no WhatsApp comum.
   - Número registrado na API não roda no app.
   - O recrutamento manual sai **de outro chip**, não do número da plataforma.
3. **Twilio:** dá pra reaproveitar a conta paga do Convivar ou criar uma subconta. O remetente WhatsApp é ligado ao portfólio do Desenrola.
   - Pra testar antes da aprovação: **sandbox do Twilio** ou número de teste da Cloud API (até 5 destinatários).
4. **Templates enviados todos de uma vez na F0** (§3.3). Aprovação e recategorização são o gargalo.

## 2. Fluxos

### 2.1 Cliente
1. **Site** (mesma home da V1). O **Diagnóstico** (Sonnet) conversa como hoje, de graça. Agora também pede o que o prestador vai perguntar: fotos, horário bom, acesso ao local (prédio, garagem). Assim evita idas e voltas depois.
2. Pra pedir orçamentos, o cliente **entra com o celular**.
   - O código chega pelo WhatsApp (template de autenticação).
   - Um checkbox diz exatamente o que ele vai receber: "avisos sobre teus pedidos (orçamentos, perguntas dos profissionais)". Esse é o opt-in do cliente.
   - O SMS (código do Convivar) fica como reserva pra depois.
3. **Matching** (§4) manda a oferta pra **todos os elegíveis**, respeitando o limite diário de cada prestador (com pouco estoque, não faz sentido escolher 5).
4. A página do pedido mostra o **progresso** ("3 profissionais avisados · 1 viu · 1 orçando") e a **expectativa** ("orçamentos costumam chegar em até X h").
   - Os orçamentos aparecem como cards, igual à V1.
   - O cliente recebe um aviso no WhatsApp.
   - **Se a janela do cliente estiver aberta, ele responde as dúvidas do prestador ali mesmo no WhatsApp** e o agente repassa. Senão, vai template com a pergunta e link.
5. **Aprovar** mostra o aviso "teu nome e telefone vão pro profissional".
   - Só então os contatos são trocados.
   - Os outros prestadores recebem um encerramento.
6. **Pós-serviço:** o follow-up pergunta ao cliente se deu certo e pede uma nota de 1 a 5, que alimenta o ranking.
- **Sem prestador cadastrado na região:** mostramos até 5 **contatos sugeridos** (busca da V1).
  - O link `wa.me` já vem com texto preenchido: "Oi, vi teu contato pelo Desenrola…".
  - É o cliente que manda, não nós. Registramos o clique.
  - Esses contatos viram leads de recrutamento.

### 2.2 Prestador
1. **Entrada na 1ª rodada:** o Bruno cadastra no `/admin` (nome, celular, categorias, bairros) os prestadores que aceitaram por telefone ou pelo chip de recrutamento.
   - O sistema manda o template `boas_vindas`: "Tu pediste pra receber pedidos de {{categoria}} em {{bairro}} pelo Desenrola. Confirma? [Sim, quero receber] [Não]".
   - **Só o "Sim" grava o `opt_in_at`**, junto com o texto e o horário da resposta.
   - A página pública `/profissional` e o cadastro conversando no WhatsApp ficam pra F1.
2. **Oferta de pedido:** template `pedido_novo`, redigido como **notificação de assinatura** (sem chamada persuasiva):
   > Pedido #{{id}} de {{categoria}} em {{bairro}}: {{resumo}}. Tu recebe isso porque se cadastrou no Desenrola.
   > [Ver detalhes] [Agora não] [Parar de receber]
   - As variáveis são **sanitizadas**: sem quebra de linha, tab ou espaço duplo, e o corpo tem no máximo 1024 caracteres.
   - **Se a Meta aprovar como marketing**, o custo é ~9× maior (§8). Viável, mas muda o preço pro prestador.
3. **Ver detalhes** abre a janela de 24h, e o **Negociador** (Haiku) apresenta o pedido.
   - Coleta valor, condições e disponibilidade.
   - Mensagens densas e poucas, porque texto livre agora pode ser cobrado (§8).
   - Usa botões interativos dentro da janela ("Confirma sexta 14h? [Sim] [Outro horário]").
4. **Uma negociação ativa por prestador por vez.**
   - O número é um só, e o texto livre do prestador precisa ter dono.
   - Se ele tem outra oferta aceita, ela espera na fila ("assim que fechar esse te mando o próximo").
   - O clique no botão carrega o `offer_id` no payload.
5. **Aprovado:** template `orcamento_aprovado` com os dados do cliente. **Não escolhido / cancelado:** `pedido_encerrado`.
6. **"Agora não"** pausa as ofertas por 48h. **"Parar de receber" e as palavras SAIR / PARAR / STOP** fazem opt-out imediato e definitivo até ele voltar. O tratamento de botão e palavra-chave vem do webhook do Convivar.
7. **Escalada pra humano:** o Negociador reconhece "falar com uma pessoa", dúvidas fora do escopo e irritação. Nesses casos ele **pausa e joga a conversa no inbox do `/admin`**, onde o Bruno responde (exigência da política: tem que haver caminho claro de escalada).

### 2.3 Admin (`/admin`)
Senha via env, token longo, cookie httpOnly e rate limit.
- **Inbox:** conversas escaladas, com o Bruno respondendo pelo número da plataforma (dentro da janela) e um botão "devolver pro agente".
- **Prestadores:** cadastrar, editar categorias e bairros, pausar, bloquear.
- **Leads:** prestadores do Google e da web com filtro por categoria e bairro, botão "copiar convite" (enviado à mão pelo chip de recrutamento) e status `novo → convidado → cadastrado | recusou | sem_whatsapp`.
- **Métricas:** pedidos sem prestador por categoria e bairro (mostra onde recrutar), tempo até o 1º orçamento e taxa de aceite.

## 3. Canal WhatsApp

### 3.1 Adaptador `server/src/channel/`
```ts
interface Channel {
  sendTemplate(to: E164, template: TemplateKey, vars: Record<string,string>): Promise<MsgId>;
  sendText(to: E164, text: string): Promise<MsgId>;                       // recusa fora da janela de 24h
  sendInteractive(to: E164, body: string, buttons: Button[]): Promise<MsgId>; // dentro da janela
  sendMedia?(to: E164, url: string, caption?: string): Promise<MsgId>;
  parseWebhook(req): InboundEvent[];   // mensagem, clique (payload), status, mudança de categoria/qualidade de template
  verifySignature(req): boolean;
}
```
- **Twilio (primeiro):** portar do Convivar `TwilioWhatsAppProvider`, que é REST puro (`Messages.json`, `ContentSid` + `ContentVariables`), mais o stub que só loga quando não há credencial.
- **Assinatura:** portar `conferirAssinatura`, um HMAC-SHA1 em tempo constante. A URL vem de **env** (`WHATSAPP_WEBHOOK_URL`), não do request, por causa do proxy do Render. Se faltar token ou URL, falha fechada. Os testes vêm junto.
- **Status de entrega:** não existe no Convivar. Construir com `StatusCallback` apontando pro mesmo webhook.
- **Meta Cloud API:** segunda implementação, só se a taxa do Twilio (~+70% sobre a utility, conferir) pesar.

### 3.2 Durabilidade
- **Webhook:** grava o evento bruto em `wa_inbound` dentro da própria request, responde 200 e processa a partir do banco. Na subida, reprocessa o que ficou pendente (o padrão `recoverNegotiations` da V1).
- **Idempotência:** `UNIQUE(provider_msg_id, status)` (o mesmo id chega como sent, delivered e read).
- **Outbox novo** (o da V1 só serve de ideia): `(to, kind: template|text|interactive|media, payload_json, offer_id, not_before, attempts, provider_msg_id, status)`. Worker com retry e backoff.
- **`wa_sessions(phone, last_inbound_at)`** decide texto livre ou template.

### 3.3 Templates (enviar todos na F0)
| Template | Categoria esperada | Uso |
|---|---|---|
| `codigo_verificacao` | authentication | login do cliente |
| `boas_vindas` | utility | confirmação do opt-in do prestador |
| `pedido_novo` | utility (risco de marketing) | oferta |
| `prestador_lembrete` | utility | "o pedido #X ainda está aberto" (lembrete do scheduler) |
| `pergunta_do_cliente` | utility | resposta do cliente fora da janela do prestador |
| `orcamento_aprovado` | utility | dados do cliente |
| `pedido_encerrado` | utility | não escolhido / cancelado (substitui os "obrigado" em texto livre do `relator.ts`) |
| `cliente_orcamento_chegou` | utility | aviso pro cliente |
| `cliente_pergunta_prestador` | utility | dúvida do prestador fora da janela do cliente |
| `cliente_avaliacao` | utility | pós-serviço |

Nenhum template é genérico ("retomar conversa"): todos levam o número e o assunto do pedido. Nenhum template apresenta "assistente virtual", porque a Meta cita isso como exemplo de marketing. A apresentação fica no texto livre.

## 4. Matching
Elegíveis: `status=ativo`, opt-in válido, sem pausa e sem bloqueio, categoria igual, área que cobre o bairro (ou a cidade toda) e abaixo do limite diário de ofertas (ex.: 10).

Ordem: nota no Desenrola, taxa de resposta, mesmo bairro, menos ofertas na semana.

**Com pouco estoque, a oferta vai pra todos os elegíveis.** O corte em 5 e a re-oferta em 2h só entram quando houver estoque.

## 5. Agentes

| Agente | Modelo | V2 |
|---|---|---|
| Diagnóstico | Sonnet | Igual, mais a coleta de fotos, horário e acesso. Gera o **resumo pro prestador** (≤ 200 caracteres, sem dados pessoais, sanitizado) |
| Buscador | Sonnet + web/Places | Não dispara mensagem. Alimenta leads e contatos sugeridos |
| Negociador | Haiku | Fala como Desenrola. Não inventa: só usa o que o cliente disse. **Nunca cita o que outro prestador disse** (política). Escala pra humano. Reaproveita ~60% (fila, debounce, lock, tools) |
| Relator | Haiku | Igual (cards + comparação). Encerramentos viram templates |
| Follow-up | Haiku | Fala com o cliente |
| Cadastro | Haiku | **F1** (entrevista no WhatsApp). Na 1ª rodada o cadastro é pelo admin |

## 6. Dados e banco

**Decisão na F0, não na F5:** o `db.ts` é síncrono (`DatabaseSync`) em todos os pontos de uso, e passar pra Postgres torna tudo assíncrono.
- **Recomendado pra 1ª rodada:** **SQLite em disco persistente do Render** (1 instância, backup diário no R2, como o Convivar faz).
  - O schema já muda inteiro agora. Migrar pra Postgres depois é mecânico e só quando tiver motivo (2 réplicas, volume).
- Alternativa: Postgres desde a F0 com um helper async único. Mais trabalho agora, nenhum depois.

Tabelas novas ou alteradas:
- `clients` (phone único, nome, cidade, bairro, endereço opcional, opt_in_at, opt_in_text).
- `sessions`. `otp_codes`: código do Convivar, com hash, TTL de 5 min, 5 tentativas com reserva atômica e limite por telefone e por IP (persistente).
- `requests.client_id`.
- `providers` + `status`, `opt_in_at`, `opt_in_text`, `opt_out_at`, `paused_until`, `bio`, `ref_code`, `lead_status`.
- `provider_categories`. `provider_areas` ganha a flag `declared`.
- `offers` (substitui `request_providers`): `enviada | vista | negociando | na_fila | orçou | escolhida | não_escolhida | recusada | expirada`.
- `wa_inbound`, `outbox`, `wa_sessions`, `handoffs` (inbox humano), `credits_ledger` (F6).

**LGPD:** base legal declarada, retenção de 90 dias dos corpos de mensagem, "apagar meus dados" e telefone liberado só com a aprovação. Logs com telefone mascarado (padrão do Convivar).

## 7. Segurança (copiar do Convivar)
- Comparação de assinatura em tempo constante.
- Webhook com falha fechada.
- `trust proxy = 1` no Render (o rate limit por IP depende disso).
- Flags de desenvolvimento (`OTP_DEV_ECHO`) que impedem subir em produção.
- Migração no `startCommand`.
- `render.yaml` como blueprint.

## 8. Custos por pedido (estimativa, conferir no rate card)

| Item | Utility | Se `pedido_novo` virar marketing |
|---|---|---|
| Diagnóstico (Sonnet) | US$ 0,01 | US$ 0,01 |
| ~5 ofertas | US$ 0,034 | **US$ 0,31** |
| Negociação: Haiku + texto livre (desde out/2026 a Meta cobra mensagens de serviço acima de 1.000 por número por mês, tarifa BR a conferir) | US$ 0,01–0,03 | idem |
| ~4 templates de utilidade (código, avisos, aprovado, encerrado) | US$ 0,027 | US$ 0,027 |
| Taxa do Twilio (~US$ 0,005 por mensagem, conferir) | US$ 0,05–0,08 | idem |
| **Total** | **~US$ 0,13–0,18** (≈ R$ 0,75–1,00) | **~US$ 0,40–0,45** |

Mesmo no pior caso, o custo cabe em uma cobrança de alguns reais do prestador por orçamento aprovado.

## 9. Fases (ordem revisada)

| Fase | Entrega | Pronto quando |
|---|---|---|
| **F0** | Portfólio Meta + número + Twilio (Bruno/sócio). Todos os templates enviados pra aprovação. Adaptador (porta do Convivar) + webhook durável + outbox + janela de 24h. **Decisão de banco. Deploy no Render** com `render.yaml` | Template sai e a resposta volta pelo webhook na URL pública (sandbox serve até a aprovação) |
| **F3** | Admin: cadastro de prestador + opt-in `boas_vindas` + **inbox humano**. Matching simples, oferta, Negociador V2 (1 negociação por prestador), Relator, aprovação e troca de contatos | Pedido ponta a ponta com a Bruna como eletricista na Cidade Baixa |
| **F2** | Login do cliente por código no WhatsApp, `clients`, **auth em todas as rotas e no SSE**, progresso e expectativa de tempo, resposta do cliente pelo WhatsApp | Dois clientes com pedidos isolados, um sem ver o do outro |
| **Teste real** | 20–30 prestadores em **2 categorias** (ex.: eletricista e encanador) e poucos bairros de Porto Alegre, recrutados antes de abrir pros clientes | 10 pedidos reais resolvidos |
| **F1** | Página `/profissional`, cadastro conversando no WhatsApp, perfil por link mágico com expiração | Prestador entra sozinho |
| **F4** | Leads + convite + métricas + contatos sugeridos com `wa.me` pré-preenchido | Recrutamento guiado por "pedidos sem prestador" |
| **F6** | Cobrança na aprovação (créditos via Pix, reaproveitando `payments.ts` com webhook no lugar de polling) | Ligado quando houver demanda |

**Cortado da 1ª rodada:** `/profissional`, link mágico, fotos no R2, SMS, prior bayesiano, créditos e re-oferta em 2h.
**Removido da V1:** Baileys, QR, `whatsapp.ts`, imitação de estilo e Pix do cliente.
**Reaproveitado:**
- `agents/claude.ts`, Diagnóstico, Relator, Follow-up, ~60% do Negociador, padrão do scheduler, `lib/*`, `services/{phone,places,geo}` e o front adaptado pra vários clientes;
- do Convivar: Twilio WhatsApp e SMS, assinatura do webhook, OTP, telefone, R2 e Render.

**Supply:** recrutar por ligação, chip de recrutamento, lojas de material elétrico e hidráulico, síndicos, grupos de bairro e Instagram local. Não raspar o GetNinjas, porque viola os termos de uso deles.

## 10. O que vem do Convivar (`/Users/brunosteinbruck/dev/convivar`)
| Peça | Arquivo | Uso no Desenrola |
|---|---|---|
| Envio WhatsApp Twilio (REST, Content API, stub) | `apps/api/src/whatsapp/whatsapp.service.ts` | adaptador `channel/twilio.ts` |
| Webhook + `conferirAssinatura` + opt-out por palavra/botão + `telefoneNacional` | `apps/api/src/whatsapp/whatsapp.webhook.controller.ts` (+ spec) | webhook da F0 |
| SMS Twilio com telefone mascarado no log | `apps/api/src/sms/sms.service.ts` | reserva do login |
| OTP (hash, TTL, tentativas atômicas, limites por telefone/IP, contas demo) | `apps/api/src/auth/auth.service.ts` | login do cliente |
| Telefone (normalizar/formatar/zod) | `packages/shared/src/dto.ts` | junto com `phone.ts` |
| R2 + upload seguro (magic bytes, token curto) | `apps/api/src/uploads/` | fotos (depois) |
| Deploy | `render.yaml` + memórias do Convivar | F0 |

O Convivar é NestJS + Prisma. As peças acima são funções puras ou REST e portam bem pro Fastify. Os decorators e guards do Nest não portam.

## 11. Revisão do Fable — o que mudou por causa dela
- **Bloqueantes incorporados:**
  - uma negociação por prestador por vez (número único);
  - auth em todas as rotas e no SSE;
  - texto livre não é mais grátis desde out/2026;
  - `pedido_novo` redigido como notificação de assinatura, com o custo de marketing previsto;
  - escalada pra humano + inbox;
  - decisão de banco na F0;
  - opt-in com confirmação explícita guardada.
- **Templates:** completados (lembrete, perguntas, encerramentos), sem template genérico, variáveis sanitizadas, "Agora não" ≠ opt-out.
- **Infra:** número de recrutamento separado, sandbox pra testar, Render pago com 1 réplica, webhook durável com `UNIQUE(id, status)`, outbox novo e `sendInteractive`.
- **Negócio:** começar pelo estoque de prestadores (2 categorias, poucos bairros), mandar pra todos os elegíveis, contatos sugeridos com texto pré-preenchido, cobrar na aprovação.
- **Fases reordenadas:** F0 → F3 → F2 → teste real → F1 → F4 → F6.
- **Fontes oficiais citadas pelo Fable:** [Pricing](https://developers.facebook.com/docs/whatsapp/pricing) · [Updates to pricing](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing) · [Template guidelines](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines) · [Template components](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components) · [Messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits) · [Política (pt-BR)](https://whatsappbusiness.com/pt-br/policy/)

## 12. Perguntas pro Bruno
1. **Quem cria o portfólio Meta** do Desenrola (teu Facebook tem restrição)? Tem **CNPJ** pra usar?
2. **Twilio:** reaproveitar a conta do Convivar (subconta) ou abrir uma nova pro Desenrola?
3. **Banco:** SQLite com disco persistente agora (recomendado) ou Postgres desde já?
4. **Categorias e bairros** do teste real: eletricista e encanador no Centro, Cidade Baixa, Bom Fim e Menino Deus?
5. **Cobrança** quando ligar: por orçamento aprovado (recomendado) ou mensalidade?
