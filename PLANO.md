# Resolvedor — Plano do MVP (Agente Meio de Campo)

> Fonte: "Agente Meio de Campo — Brief do MVP" (PDF). Sem login, usuário único, roda local.
> Posicionamento: "resolve teu problema sem perder a tarde no WhatsApp".

## 1. Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Runtime | Node 24 + TypeScript (ESM), `tsx` em dev | Baileys é Node (exige ≥20); um só idioma |
| Servidor | Fastify 5 | leve, SSE fácil, tipado |
| Banco | SQLite via `node:sqlite` (`DatabaseSync`) — arquivo `data/resolvedor.db` | sem dependência nativa pro banco; suficiente pro MVP |
| WhatsApp | `@whiskeysockets/baileys` **fixado em `7.0.0-rc14`** (sem `^`; `baileys` no npm é o mesmo tarball, mas usamos o nome oficial) + `qrcode` pra gerar PNG | decisão do brief; sessão fica no servidor (`data/wa-auth/`). Ainda é RC: fixar versão evita quebra silenciosa. Puxa `whatsapp-rust-bridge` (WASM) e peer deps opcionais (`sharp`/`jimp`) — só o banco é "zero nativo", não o projeto inteiro |
| IA | `@anthropic-ai/sdk`, modelo `claude-opus-5-5`, thinking adaptativo (sempre ligado), `output_config.effort` explícito por agente | agentes com tools |
| Busca de prestadores | Google Places API (New) Text Search; fallback: tool `web_search_20260209` do Claude quando não há `GOOGLE_MAPS_API_KEY` | brief: "principalmente pelo Google" |
| Áudio | OpenAI Whisper (`whisper-1`) via REST (`fetch` + `FormData`) | brief cita Whisper; só transcrição |
| Pagamento | Pix via Mercado Pago (`POST /v1/payments`, `payment_method_id: "pix"`) quando `MP_ACCESS_TOKEN` existe; senão modo simulado (botão "simular pagamento") | brief passo 7 |
| Front | Vite + React 19 + TypeScript, CSS próprio (sem framework de UI pesado) | design slim, sob controle |
| Tempo real | SSE (`GET /api/stream`) do servidor pro front | chat ao vivo, QR, status |

Regras transversais do uso da API Claude (valem pra todo agente):
- **Nunca** enviar `thinking: {type: "disabled"}` nem `budget_tokens` — no `claude-opus-5-5` ambos dão 400. Omitir `thinking` (ou `{type: "adaptive"}`) e controlar custo/latência com `output_config.effort`. O default é `medium`; definir explicitamente: F1 `low`, F2 `medium`, F5 `medium`, F6 resumo `low`.
- **Nunca** usar `tool_choice: any` / `tool` (400). Sempre `auto` + `strict: true` nas tools + instrução no prompt ("use a tool X quando…"). O código **verifica** se a tool foi chamada e, se não foi, pede de novo (1 retry) ou segue como texto.
- `max_tokens` com folga pro thinking (ele conta): 8k pra F1/F6, 16k pra F2/F5.
- **Histórico append-only** (thinking preservado): salvar o `content` completo da resposta do assistente (incluindo blocos `thinking`, sem alterar) e só anexar turnos. Nunca editar turnos antigos, nunca trocar o `system` nem a lista de `tools` no meio de uma conversa. Dados variáveis (nome do usuário, pedido, prestador) vão na **primeira mensagem `user`**, não no `system`, pra o `system` ser byte-idêntico entre requisições (também melhora cache).
- Eventos do app no meio da conversa (ex.: "usuário aprovou o orçamento") entram como **novo turno `user`** com prefixo `[evento]`, nunca editando o passado. Mensagem `{role: "system"}` dentro de `messages` só quando vier imediatamente após um turno `user` (regra da API); como os históricos dos negociadores costumam terminar em turno do assistente, o padrão é `user`.
- Todo `tool_use` recebe `tool_result` na mesma rodada (mesmo que seja "aguardando o usuário"); o histórico nunca fica terminando em `tool_use` pendente.
- Streaming (`client.messages.stream`) em todo agente; tratar `stop_reason: "refusal"` (mostrar mensagem neutra e registrar) e `max_tokens`.
- Thinking fica com `display` default (omitido); no F1 usar `display: "summarized"` só se quisermos mostrar "pensando…" no front — senão aceitar a pausa antes do texto.

Estrutura:
```
Resolvedor/
  server/src/
    index.ts            # Fastify, rotas, SSE, serve web/dist em produção
    db.ts               # schema + migrations + helpers
    events.ts           # EventEmitter -> SSE
    whatsapp.ts         # Baileys: conexão, QR, envio (fila), recebimento, mapeamento JID/LID
    agents/
      claude.ts         # cliente, regras comuns (effort, strict tools, append-only, refusal)
      diagnostico.ts    # Funcionário 1: conversa com o usuário
      buscador.ts       # Funcionário 2: acha ~5 prestadores
      negociador.ts     # Funcionário 3: conversa com cada prestador
      relator.ts        # Funcionário 4: cards de orçamento + resumo comparativo
      followup.ts       # Funcionário 5: pós-serviço + nota
    services/
      places.ts  transcribe.ts  payments.ts  phone.ts  scheduler.ts
  web/src/              # React
  data/                 # db + sessão WA (gitignored)
  .env.example
```

## 2. Modelo de dados (SQLite)

- `settings` (key, value): `user_name`, `user_email` (obrigatório pro Pix do MP), `user_city`, `price_per_request` (default 15,00), `credits`, `wa_warning_seen` (aviso de risco de ban já mostrado).
- `requests` (pedidos): id, title, summary, category (profissão), city, neighborhood, details_json, status, created_at, updated_at, scheduled_for, closed_at, closed_provider_id, closed_value_cents.
  - status: `diagnostico` → `buscando` → `escolhendo` → `pagamento` → `contatando` → `orcamentos` → `aguardando_confirmacao` → `fechado` → `avaliado`; também `cancelado` (de qualquer estado) e `sem_prestadores` (busca vazia ou todos sem WhatsApp).
- `messages` (chat usuário↔agente no site): id, request_id, role (`user|assistant|system_event`), content, card_json (cartões: lista de prestadores, QR, orçamento, pagamento, avaliação), created_at.
- `agent_state`: request_id, agent (`diagnostico`), messages_json (histórico Anthropic completo, **append-only, com o `content` do assistente intacto — blocos `thinking` incluídos**).
- `providers`: id, name, phone_e164 (como veio da fonte, normalizado só pra exibição), wa_jid (**o `jid` devolvido por `onWhatsApp`**, pode diferir do E.164 pelo 9º dígito), wa_lid (`...@lid`, preenchido quando aprendido), source (`google|web`), place_id, rating_google, reviews_google, address, website, our_rating_avg, our_rating_count, blocked.
- `request_providers`: id, request_id, provider_id, selected (bool), status (`sugerido|excluido|na_fila|sem_whatsapp|contatado|respondeu|orcou|sem_resposta|recusou|recusado_pelo_usuario|pausado|aprovado|fechado|dispensado`), quote_value_cents, quote_conditions, quote_availability, agent_messages_json (histórico do negociador, mesma regra append-only), last_activity_at, reminder_sent_at, pending_inbound_json (mensagens recebidas enquanto o agente estava no meio de um turno).
  - `pausado`: o usuário respondeu o prestador **à mão** pelo celular; o agente para de falar com esse prestador e avisa no chat.
  - `dispensado`: recebeu o "obrigado, já resolvi" depois de outro ser aprovado.
- `wa_messages`: id, request_provider_id, direction (`in|out`), wa_message_id **UNIQUE** (dedupe: o Baileys pode reentregar mensagens após reconexão), body, media_type, transcript, created_at. (log de tudo que saiu/entrou — só de prestadores do pedido.)
- `outbox`: id, request_provider_id, body, not_before, sent_at, wa_message_id — fila de envio persistente (escalonamento e recuperação após restart).
- `payments`: id, request_id, provider (`mercadopago|simulado`), external_id, idempotency_key, status, amount_cents, qr_code, qr_base64, ticket_url, expires_at, created_at.
- `ratings`: id, request_id, provider_id, stars, comment, service_done (bool), created_at.

## 3. Os funcionários (agentes) e atividades

### F1 — Diagnóstico (chat do site)
- Entrada: texto livre "Qual problema você quer resolver hoje?".
- Conversa curta (1–3 perguntas no máximo) pra entender: o que é, urgência, bairro/cidade, fotos opcionais (fora do MVP).
- Tools (declaradas na **primeira** requisição e nunca alteradas): `definir_diagnostico({ titulo, resumo_para_prestador, profissao, cidade, bairro, urgencia })` com `strict: true`. Quando chamada → muda status pra `buscando` e dispara F2. A fala do agente: "Pra isso tu precisa de um eletricista. Quer que eu chame os da tua região?" — o usuário confirma com botão no card.
- Como não dá pra forçar a tool: o prompt manda chamar `definir_diagnostico` assim que tiver profissão + bairro; se depois de 4 turnos não chamou, o código anexa, **logo depois da próxima mensagem do usuário** (mensagem `system` no meio da conversa só pode vir após um turno `user`), um turno `{role: "system"}` "chame `definir_diagnostico` agora com o que tem".
- Diagnóstico é grátis.

### F2 — Buscador
- Google Places Text Search (`POST https://places.googleapis.com/v1/places:searchText`), header `X-Goog-Api-Key` + `X-Goog-FieldMask` obrigatório, **todos os caminhos com prefixo `places.`**:
  `places.id,places.displayName.text,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.formattedAddress,places.websiteUri,places.businessStatus`.
  Body: `textQuery: "{profissao} em {bairro}, {cidade}"`, `languageCode: "pt-BR"`, `regionCode: "BR"`, `pageSize: 20` (não usar `maxResultCount`, depreciado), sem `locationBias` no MVP (não temos Geocoding no stack; cidade+bairro no `textQuery` + `regionCode` bastam), e **`includePureServiceAreaBusinesses: true`** — eletricista/encanador sem loja física some da busca sem isso (esses resultados vêm sem `formattedAddress`/localização; tratar como opcional).
  Custo: telefone/rating/website são SKU Enterprise — uma chamada por pedido, nunca em loop.
- Filtra: `businessStatus == OPERATIONAL`, tem algum telefone, nota ≥ 4.0 quando houver. **Não** descartar por "parece fixo": a validação de celular/WhatsApp é feita no F4 com `onWhatsApp`, que é quem sabe de verdade (resolve inclusive o 9º dígito). `phone.ts` só normaliza pra E.164 (`+55DDD…`) pra exibir e deduplicar.
- Ranking: `rating * log10(reviews+1)` + bônus para nota interna (`our_rating_avg`) + penaliza `blocked`. Reaproveita `providers` existentes por `place_id`/telefone.
- Pega os 8 melhores, valida WhatsApp (F4) e retorna até 5 com WhatsApp → card "Encontrei esses 5" com toggle por prestador (confirmar/excluir) + botão "Chamar selecionados". Se sobrar 0 → status `sem_prestadores` e o F1 pergunta se quer ampliar a busca (outro bairro/cidade).
- Fallback sem chave Google, em **dois passos** (não dá pra forçar tool): (1) requisição com `web_search_20260209` (`user_location` BR, `max_uses: 5`) pedindo lista de prestadores com nome, telefone e fonte; (2) requisição separada, sem tools, com `output_config.format` (JSON schema) pra extrair a lista estruturada do texto do passo 1. Verificar na implementação se `output_config.format` pode ir junto com server tools; se puder, vira um passo só.

### F3 — Pagamento (antes de disparar)
- Ao clicar "Chamar selecionados": se há crédito, consome 1; senão cria cobrança Pix (MP) ou simulada → card com QR Pix + copia-e-cola → **polling no servidor** (`GET /v1/payments/{id}` a cada 5s, até `expires_at`) que emite `payment.updated` via SSE. Sem webhook no MVP: o app roda local, não tem URL pública (webhook exigiria túnel + validação `x-signature`). Deixar `POST /api/webhooks/mercadopago` fora.
- Mercado Pago, `POST https://api.mercadopago.com/v1/payments`: headers `Authorization: Bearer`, **`X-Idempotency-Key` obrigatório** (UUID salvo em `payments.idempotency_key`); body `transaction_amount` (number, reais), `description`, `payment_method_id: "pix"`, `payer.email` (**obrigatório** — vem de `settings.user_email`; pedir na primeira cobrança), `date_of_expiration` (ISO; usar 30 min, mínimo aceito). `payer.identification` (CPF) aparece nos exemplos mas não está marcado como obrigatório: verificar na implementação; se a API exigir, adicionar `user_cpf` em settings (nunca passa pro agente).
- Resposta: `status: "pending"`, `point_of_interaction.transaction_data.qr_code` (copia-e-cola), `.qr_code_base64` (imagem), `.ticket_url`. Pago quando `status == "approved"`.
- Pago → status `contatando`. Expirou → card "Pix expirou, gerar outro".

### F4 — Conexão WhatsApp
- Se não conectado no momento do disparo, mostra card com QR code (`connection.update.qr`, `printQRInTerminal` está depreciado; atualiza via SSE a cada QR novo). Também acessível por um botão discreto "WhatsApp" na sidebar (`POST /api/whatsapp/connect`).
- Primeiro uso: aviso de risco de ban (aparelho vinculado não oficial) com "entendi" → `settings.wa_warning_seen`.
- Sessão persistente em `data/wa-auth` (`useMultiFileAuthState`); **`sock.ev.on('creds.update', saveCreds)` sempre** — sem isso as chaves mudam e os envios param de chegar.
- `makeWASocket` com: `syncFullHistory: false`, `markOnlineOnConnect: false` (senão o celular do usuário para de receber notificação), `getMessage` lendo de `wa_messages` (retries de envio), `shouldIgnoreJid` (síncrono, recebe só o JID cru) devolvendo `true` pra grupos (`@g.us`), broadcast/status, newsletter e **qualquer JID `@s.whatsapp.net` que não esteja em `providers.wa_jid` de um `request_provider` ativo** (lookup num `Set` em memória, recarregado do banco quando `request_providers` muda). **JID `@lid` desconhecido nunca é ignorado aqui**: a primeira resposta de um prestador pode chegar como `@lid` antes de termos `wa_lid`, e só no `messages.upsert` existe `remoteJidAlt` pra reconhecer. Então: PNs de fora do pedido nem são decriptados; LIDs desconhecidos são decriptados, checados no handler e descartados sem persistir se não forem prestador.
- Reconexão por `lastDisconnect.error.output.statusCode`: `loggedOut` (401) → apaga `data/wa-auth`, status `desconectado`, pede QR; `restartRequired` (515, acontece logo após o pareamento) → recria o socket; `connectionReplaced` (440) / `badSession` (500) → backoff exponencial (5s → 2min) e aviso no chat, sem loop quente; demais → reconecta com backoff.
- Validação de número: `sock.onWhatsApp(phoneE164)` recebe telefone (não JID) e **só devolve entradas que existem** (número sem WhatsApp simplesmente não aparece no array). Guardar o `jid` devolvido em `providers.wa_jid` — é assim que o 9º dígito brasileiro se resolve (o JID do WhatsApp pode ter ou não o 9). Sem WhatsApp → `sem_whatsapp`, avisa no chat.
- LID (v7): mensagem recebida pode vir com `key.remoteJid` em `...@lid` e `key.remoteJidAlt` com o número (`...@s.whatsapp.net`), ou o contrário. Resolver o `request_provider` procurando por **qualquer um dos dois** em `wa_jid`/`wa_lid`; ao encontrar, preencher o que faltava. Também ouvir `lid-mapping.update` e, em último caso, `sock.signalRepository.lidMapping.getPNForLID(lid)`. Enviar sempre pro `wa_jid` (PN) — o Baileys resolve internamente.
- Caps do WhatsApp: ouvir `message-capping.update` e `connection.update.reachoutTimeLock`; se a cota de "conversas novas" estourou ou há time lock, pausar a `outbox`, status `na_fila`, e avisar o usuário com o prazo. (Ver §8.)

### F5 — Negociador (um por prestador)
- Primeira mensagem gerada pelo agente, natural, curta, em PT-BR, em nome do usuário: se apresenta como assistente do {user_name}, descreve o problema e pede orçamento/disponibilidade. Se perguntarem, admite que é assistente virtual (honestidade).
- Envio via `outbox` com um único worker: intervalo aleatório 20–60s entre prestadores (`not_before`), "digitando..." (`sendPresenceUpdate('composing', jid)`, expira em ~10s — reenviar pra textos longos) proporcional ao tamanho do texto. Reduz risco de ban. O id da mensagem é gerado **antes** do envio (`generateMessageIDV2()` passado em `sendMessage(jid, content, { messageId })`) e gravado na `outbox`/`wa_messages` antes de chamar o Baileys — é o que distingue "nós mandamos" de "o usuário digitou no celular" (o Baileys ecoa os próprios envios no `messages.upsert` como `append` + `fromMe`, `emitOwnEvents` é `true` por padrão).
- Recebimento (`messages.upsert`): processa `type: 'notify'`; `type: 'append'` só quando for de um prestador ativo e não `fromMe` (recuperação de mensagens que chegaram offline — seguro por causa do UNIQUE). Ignora o que `shouldIgnoreJid` já não filtrou: sem `message`, `protocolMessage`, reações. Desembrulha `ephemeralMessage`/`viewOnceMessage` (`normalizeMessageContent` + `getContentType`). **Todas as outras conversas do WhatsApp do usuário são ignoradas e nunca lidas/armazenadas.**
- **Mensagem `fromMe` numa conversa de prestador cujo `key.id` não está em `outbox`/`wa_messages`** = o usuário respondeu à mão pelo celular → `pausado`, aviso no chat ("vi que tu respondeu o {prestador} direto; parei de falar com ele. Quer que eu retome?") com botão "Retomar". Sem isso agente e humano falam por cima um do outro.
- Debounce de 8s por prestador (agrupa mensagens picadas antes de responder).
- Concorrência: **uma fila/mutex por `request_provider`**. Se chegar mensagem enquanto o agente desse prestador está no meio de um turno, ela vai pra `pending_inbound_json`; ao terminar o turno, se houver pendência, abre um novo turno com tudo junto. Turnos de prestadores diferentes rodam em paralelo.
- Áudio: baixa (`downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })`), transcreve com Whisper, entra como "[áudio transcrito]: ...". Imagem/documento: registra "[prestador enviou uma imagem]" (MVP).
- Tools (todas `strict: true`, declaradas na primeira requisição):
  - `registrar_orcamento({ valor_reais, condicoes, disponibilidade })`
  - `pedir_decisao_usuario({ pergunta })` — qualquer coisa que dependa do usuário (horário, aceitar valor, dado pessoal como endereço completo). O `tool_result` é devolvido **imediatamente** ("pergunta encaminhada ao usuário, aguardando") pra o histórico nunca terminar num `tool_use` sem resposta (senão a próxima chamada dá 400 e nem mensagem nova do prestador pode ser anexada); o agente encerra o turno (pode mandar um "vou confirmar e te retorno" pro prestador), status `respondeu`. A resposta do usuário entra depois como turno `user` com prefixo `[usuário]: ...`.
  - `marcar_sem_interesse({ motivo })` — prestador não atende / recusou.
  - `confirmar_fechamento({ data_servico })` — **só funciona se o usuário já aprovou esse orçamento no site** (checado no código: `status == 'aprovado'`; senão retorna `tool_result` com `is_error` explicando).
- O que o agente **não** recebe no contexto: endereço completo, CPF, e-mail, telefone do usuário. Só bairro. Assim "nunca vaza" é garantia do código, não só do prompt.
- Regra dura: nunca fecha preço/visita sem aprovação; nunca passa endereço completo/CPF sem o usuário liberar (e mesmo liberado, o usuário digita a informação como resposta a `pedir_decisao_usuario`).
- Cobrança de quem sumiu: scheduler verifica `last_activity_at`; sem resposta em 3h (horário comercial 8h–20h) → uma mensagem de lembrete (grava `reminder_sent_at`, idempotente); 24h depois do lembrete → `sem_resposta`.
- Ligação recebida (`call` event): não atende; registra evento e enfileira "Agora não consigo atender, pode me mandar por aqui?" (uma vez por prestador).
- Recuperação após restart: nada vive só em memória. Na subida, o servidor (1) reconecta o Baileys, (2) retoma a `outbox` não enviada, (3) reprocessa `pending_inbound_json` e (4) o scheduler continua pelo banco. Mensagens reentregues pelo Baileys caem no UNIQUE de `wa_messages`.

### F6 — Relator
- É quase todo código, não um loop de agente: quando `registrar_orcamento` dispara (ou muda), posta no chat do site um card de orçamento: prestador, nota Google, valor, condições, disponibilidade, botões **Aprovar** / **Recusar** / **Responder** (texto livre repassado ao negociador daquele prestador). Status do pedido vira `orcamentos`.
- Quando ≥2 orçamentos, uma chamada simples ao Claude (sem tools, `effort: low`) gera um resumo comparativo curto.
- Aprovar → marca `aprovado`, status do pedido `aguardando_confirmacao`, anexa um turno **`user`** com prefixo `[evento]` no histórico daquele negociador ("[evento] usuário aprovou este orçamento; confirme a data com o prestador e chame `confirmar_fechamento`"). Não usar `role: "system"` aqui: mensagem `system` no meio da conversa só é aceita logo após um turno `user`, e o histórico do negociador normalmente termina em turno do assistente. Quando `confirmar_fechamento` roda → `fechado`, `closed_at`, `scheduled_for`. Os outros ativos recebem uma mensagem educada de "obrigado, já resolvi" → `dispensado` (opcional, ligado por padrão).
- Recusar → `recusado_pelo_usuario` (diferente de `recusou`, que é o prestador recusando); o negociador recebe `[evento] usuário recusou`, manda um "obrigado, vou avaliar" e encerra.

### F7 — Follow-up pós-serviço
- Scheduler: depois de `scheduled_for` + 1 dia (ou `closed_at` + 3 dias se não houver data), posta no chat do pedido "O serviço foi feito? Que nota tu dá pro {prestador}?" com card de 1–5 estrelas + comentário.
- Grava `ratings`, atualiza `our_rating_avg/count`, status `avaliado`. Isso alimenta o ranking do F2.

### Scheduler (`services/scheduler.ts`)
- Um único `setInterval` de 60s que varre o banco: lembretes (F5), `sem_resposta`, expiração de Pix, follow-up (F7). Cada ação é idempotente por coluna de carimbo (`reminder_sent_at`, `payments.status`, `requests.status`), então rodar duas vezes não duplica nada.

## 4. API (contrato front ↔ back)

```
GET  /api/requests                         -> lista (sidebar)
POST /api/requests        {text}           -> cria pedido + 1ª msg, roda F1
GET  /api/requests/:id                     -> pedido + messages + providers + quotes + payment atual
POST /api/requests/:id/messages {text, providerId?} -> sem providerId: mensagem pro F1; com providerId: repassada ao negociador daquele prestador
POST /api/requests/:id/search              -> confirma diagnóstico e roda F2
POST /api/requests/:id/providers/:rpId     {selected}  -> toggle
POST /api/requests/:id/dispatch            -> cria pagamento / consome crédito (exige WhatsApp conectado; senão 409 + card de QR)
POST /api/requests/:id/cancel              -> cancelado; prestadores já contatados recebem "obrigado, não vou precisar"
POST /api/payments/:id/simulate            -> (modo simulado)
GET  /api/payments/:id                     -> status (fallback do SSE)
POST /api/requests/:id/quotes/:rpId/approve | /reject
POST /api/requests/:id/quotes/:rpId/reply  {text}
POST /api/requests/:id/providers/:rpId/resume -> sai de `pausado`, agente retoma
POST /api/requests/:id/rating              {providerId, stars, comment, serviceDone}
GET  /api/whatsapp                          -> {status: desconectado|qr|conectando|conectado, qr?, me?}
POST /api/whatsapp/connect                  -> inicia pareamento (gera QR)
POST /api/whatsapp/logout
GET  /api/settings | PUT /api/settings      -> user_name, user_email, user_city, price_per_request
GET  /api/stream                            -> SSE: message.created, message.delta, request.updated, provider.updated, wa.status, wa.qr, payment.updated
```
Streaming do texto do F1: eventos `message.delta` via SSE. O front reconecta o SSE sozinho e, ao reconectar, refaz `GET /api/requests/:id` do pedido aberto.

## 5. Front (diretriz de design)

- Referência: claude.ai / ChatGPT. Sidebar esquerda fina com "Novo problema" + histórico de pedidos (título + status em texto pequeno). Centro: título discreto, caixa de texto centralizada "Qual problema você quer resolver hoje?".
- Direção escolhida: **A · Grafite**, em estilo **liquid glass** (superfícies translúcidas com blur, borda de brilho fina, sobre um fundo claro neutro). Sidebar e caixa de texto são as peças de vidro; o resto fica limpo.
- Pouquíssima informação na tela. Sem gradiente roxo, sem emoji, sem cards em todo lugar. Tipografia boa (Inter), muito espaço, uma cor de acento (verde #1f7a4d).
- Os "cards" do fluxo (prestadores, QR, Pix, orçamento, avaliação, "pausado") aparecem inline no chat, discretos (borda fina, sem sombra pesada).
- Opções de design geradas no Claude Design (artefato Design) para o usuário escolher antes de implementar o front.

## 6. Configuração (.env)

```
ANTHROPIC_API_KEY=
GOOGLE_MAPS_API_KEY=        # opcional (fallback: busca web do Claude)
OPENAI_API_KEY=             # opcional (sem ele, áudio vira "[áudio não transcrito]")
MP_ACCESS_TOKEN=            # opcional (sem ele, pagamento simulado)
PORT=3333
```

## 7. Ordem de execução

1. Scaffold (server + web), `.env.example`, scripts `npm run dev` (server+web juntos).
2. DB + eventos SSE.
3. WhatsApp (QR, sessão, `shouldIgnoreJid`, outbox, recebimento com mapeamento JID/LID, `fromMe` → pausado, áudio). Testar com o próprio número de teste antes de qualquer agente.
4. F1 Diagnóstico com streaming.
5. F2 Buscador (Places + fallback).
6. F3 Pagamento (MP + simulado).
7. F5 Negociador + F6 Relator.
8. F7 Follow-up + scheduler.
9. Front com o design escolhido.
10. Teste ponta a ponta: um pedido real com o número de teste do próprio usuário como "prestador"; incluir reinício do servidor no meio da negociação.

## 8. Riscos aceitos (do brief)
- WhatsApp Web é não oficial → risco de ban do número do usuário. Mitigação: poucos contatos por pedido, intervalos, mensagens naturais, um aviso no primeiro uso. O WhatsApp também impõe **cota de conversas novas** e *time locks* por conta (eventos `message-capping.update` / `reachoutTimeLock`); o app respeita e avisa em vez de insistir.
- Baileys 7 ainda é RC: versão fixada; atualização só com teste manual do fluxo inteiro.
- O servidor guarda acesso ao WhatsApp inteiro → roda local, sessão em disco local, só decripta/lê conversas de prestadores do pedido (`shouldIgnoreJid`).
- Ligações não são atendidas.
- Sem webhook do Mercado Pago (app local): confirmação por polling, Pix expira em 30 min.

## 9. Revisão (Fable)

- **Baileys, pacote/versão**: `baileys` e `@whiskeysockets/baileys` são o mesmo tarball (7.0.0-rc14); plano agora fixa `@whiskeysockets/baileys@7.0.0-rc14` sem `^` e registra que é RC com deps WASM/peer (a alegação "zero nativo" ficou só pro SQLite).
- **LID (v7)**: mensagens podem chegar com `remoteJid` em `@lid` e o número em `remoteJidAlt` (ou o inverso); adicionado procedimento de resolução por qualquer uma das duas colunas (`wa_jid`/`wa_lid`), backfill, `lid-mapping.update` e `getPNForLID` como último recurso; envio sempre pro PN.
- **`onWhatsApp`**: recebe telefone (não JID), só devolve quem existe (ausente ≠ `exists:false`) e o `jid` devolvido é a fonte da verdade pro 9º dígito brasileiro; removida a heurística "celular começa com 9" do F2 — a validação é do F4.
- **Ignorar o resto do WhatsApp**: antes era só filtro no handler; agora é `shouldIgnoreJid` (grupos, status, newsletter e PNs que não são prestador ativo) + filtro de LID no handler, mais `syncFullHistory: false` e `markOnlineOnConnect: false`. `@lid` desconhecido **não** pode ser ignorado em `shouldIgnoreJid` (é síncrono e sem `remoteJidAlt`) — senão a primeira resposta do prestador some.
- **Eco dos próprios envios**: o Baileys reemite o que o socket manda (`emitOwnEvents: true`, `append` + `fromMe`); `pausado` só dispara quando o `key.id` não é nosso — por isso o id é gerado antes e passado em `sendMessage({ messageId })`.
- **Contratos da API Claude que dariam 400**: `pedir_decisao_usuario` deixava `tool_use` sem `tool_result` (agora responde na hora e o usuário entra como turno `user`); eventos de aprovação/recusa entravam como `system` depois de turno do assistente (agora turno `user` com `[evento]`); empurrão do F1 só após mensagem do usuário.
- **Estados**: `recusou` (prestador) separado de `recusado_pelo_usuario`. `locationBias` cortado (sem Geocoding no stack).
- **`creds.update`/reconexão**: adicionado `saveCreds` obrigatório e tabela de `DisconnectReason` (401 limpa sessão, 515 recria socket, 440/500 backoff sem loop).
- **`notify` vs `append`, dedupe**: processa `notify`; `append` só de prestador ativo e não-`fromMe`; `wa_messages.wa_message_id` UNIQUE pra reentregas; desembrulhar ephemeral/viewOnce.
- **Usuário responde à mão**: estado `pausado` (mensagem `fromMe` na conversa do prestador) + rota `resume`; antes agente e humano falariam por cima.
- **Caps do WhatsApp**: `message-capping.update` / `reachoutTimeLock` pausam a outbox e avisam; registrado em riscos.
- **Claude API**: regras transversais — sem `thinking: disabled`/`budget_tokens`, `effort` explícito por agente (default é `medium`), sem `tool_choice: any/tool` (usar `auto` + `strict` + verificação no código), histórico append-only com `content` do assistente intacto, `system`/`tools` imutáveis por conversa, dados variáveis na 1ª mensagem `user`, instruções no meio como turno `system`, tratar `refusal`.
- **F1 sem tool forçada**: instrução no prompt + turno `system` de empurrão depois de 4 turnos.
- **F2 fallback web**: virou dois passos (web_search → extração com `output_config.format`) porque não dá pra forçar tool; marcado pra verificar se dá pra fundir.
- **Places**: field mask corrigido (todos com `places.`, `displayName.text`), `pageSize` no lugar de `maxResultCount`, `languageCode`/`regionCode` BR, `includePureServiceAreaBusinesses: true` (senão prestadores sem loja somem), aviso de SKU Enterprise.
- **Mercado Pago**: `X-Idempotency-Key` obrigatório, `payer.email` obrigatório (novo `settings.user_email`), `date_of_expiration` 30 min, campos do QR em `point_of_interaction.transaction_data`, confirmação por `GET /v1/payments/{id}`; CPF marcado como "verificar". Webhook cortado (app local sem URL pública) — polling no servidor.
- **Concorrência/restart**: mutex por prestador, `pending_inbound_json` pra mensagens durante o turno, `outbox` persistente pro escalonamento, scheduler único de 60s idempotente por carimbo, e rotina de subida que recupera tudo do banco.
- **Estados faltando**: `sem_whatsapp` (usado mas não listado), `pausado`, `dispensado`, `sem_prestadores`, `closed_at`, `reminder_sent_at`, `expires_at`.
- **API**: `providerId` explícito em `/messages` (antes "quando referenciar um prestador"), `message.delta` incluído na lista SSE, novas rotas `cancel`, `whatsapp/connect`, `providers/:rpId/resume`, `GET /api/payments/:id`; `dispatch` exige WhatsApp conectado; webhook removido.
- **Privacidade por código**: o negociador não recebe endereço completo/CPF/e-mail/telefone do usuário no contexto; `confirmar_fechamento` checa `aprovado` no banco.
- **F6 simplificado**: Relator é código + uma chamada sem tools pro resumo, não um quinto loop de agente.
- **F7**: fallback `closed_at + 3 dias` quando não há `scheduled_for`.
