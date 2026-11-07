# Desenrola — contrato da API (back-end)

Complementa PLANO.md §4. Tudo JSON. Erros: `{ error: string, code?: string }` com status HTTP adequado (400 dados inválidos, 404 não encontrado, 409 etapa errada, 502 Mercado Pago). Datas são ISO 8601 (UTC). Valores em centavos (`*_cents`).

## Rotas

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/api/requests` | | `Array<{ id, title, status, updated_at }>`, mais recente primeiro. Sem título ainda → primeiros 60 caracteres da 1ª mensagem do usuário. |
| POST | `/api/requests` | `{ text }` | `201 { id }` na hora; o F1 roda em segundo plano (resposta chega por SSE). |
| GET | `/api/requests/:id` | | ver abaixo |
| POST | `/api/requests/:id/messages` | `{ text, providerId? }` | `{ ok: true }` rápido. Sem `providerId` → F1. Com `providerId` → negociador daquele prestador. **`providerId` é o `rpId`** (o `id` da lista `providers`); por compatibilidade também aceita o `provider_id`. |
| POST | `/api/requests/:id/search` | | `{ ok: true }`; roda o F2 em segundo plano. 409 se ainda não há diagnóstico ou se a etapa não permite (só `diagnostico`, `sem_prestadores`, `escolhendo`). |
| POST | `/api/requests/:id/providers/:rpId` | `{ selected: boolean }` | `{ ok: true }`. Só enquanto o pedido está em `escolhendo`/`pagamento` e o prestador em `sugerido`. |
| POST | `/api/requests/:id/dispatch` | | `{ ok, mode: 'credit' }` ou `{ ok, mode: 'payment', payment }` (shape de `payment` abaixo). WhatsApp desconectado → **409 `{ error, code: 'wa_not_connected' }`**, inicia o pareamento e posta um card `whatsapp` no chat. Sem e-mail com Mercado Pago ativo → 400 `{ code: 'email_required' }`. Chamado de novo com Pix pendente devolve o mesmo Pix; depois de expirado gera outro. |
| POST | `/api/requests/:id/cancel` | | `{ ok: true }` |
| POST | `/api/requests/:id/quotes/:rpId/approve` | | `{ ok: true }` |
| POST | `/api/requests/:id/quotes/:rpId/reject` | | `{ ok: true }` |
| POST | `/api/requests/:id/quotes/:rpId/reply` | `{ text }` | `{ ok: true }`; também usado pra responder um card `decision`. |
| POST | `/api/requests/:id/providers/:rpId/resume` | | `{ ok: true }`; 409 se o prestador não está `pausado`. |
| POST | `/api/requests/:id/rating` | `{ providerId, stars (1–5), comment?, serviceDone? }` | `{ ok: true }`. Aqui `providerId` é o `provider_id` (vem do card `rating`). |
| GET | `/api/payments/:id` | | `payment` + `request_id` |
| POST | `/api/payments/:id/simulate` | | `payment` + `request_id` (só `provider: 'simulado'`) |
| GET | `/api/whatsapp` | | `{ status: 'desconectado'\|'qr'\|'conectando'\|'conectado', qr: string\|null (PNG data URL), me: string\|null, warning_seen: boolean }` |
| POST | `/api/whatsapp/connect` | | mesmo shape do GET. O QR chega uns segundos depois (SSE `wa.status` ou GET de novo). |
| POST | `/api/whatsapp/logout` | | mesmo shape do GET |
| GET | `/api/settings` | | `{ user_name, user_email, user_city, price_per_request: number (reais), credits: number, wa_warning_seen: boolean }` |
| PUT | `/api/settings` | qualquer subconjunto de `{ user_name, user_email, user_city, price_per_request, wa_warning_seen }` | settings atualizados. **"Entendi" do aviso de risco de ban = `PUT { wa_warning_seen: true }`.** `credits` é só leitura. |
| GET | `/api/health` | | `{ ok, claude, places, mercadopago, transcription, devTestProvider }` (booleans: quais chaves estão configuradas) — extra, não estava no plano. |
| GET | `/api/stream` | | SSE (abaixo) |

### `GET /api/requests/:id`

```ts
{
  request: { id, title, status, summary, category, city, neighborhood, scheduled_for, closed_provider_id, closed_value_cents, created_at, updated_at },
  messages: Array<{ id: number, role: 'user'|'assistant'|'system_event', content: string, card: Card|null, created_at: string }>,
  providers: Array<{
    id /* rpId */, provider_id, name, phone_display /* "(51) 99999-0000" */, rating_google: number|null, reviews_google: number|null,
    address: string|null, selected: boolean, status: string,
    quote_value_cents: number|null, quote_conditions: string|null, quote_availability: string|null, last_activity_at: string|null
  }>,   // ordenados por posição do ranking ("Prestador de teste" primeiro, se houver)
  payment: null | { id, provider: 'mercadopago'|'simulado', status: 'pending'|'approved'|'expired'|'cancelled', amount_cents,
                    qr_code /* copia-e-cola */, qr_base64 /* PNG em base64 SEM o prefixo data: */, ticket_url, expires_at }
}
```
`payment` é o mais recente do pedido. `qr_base64` vem cru (como o Mercado Pago devolve): usar `data:image/png;base64,${qr_base64}`.

Status do pedido: `diagnostico → buscando → escolhendo → pagamento → contatando → orcamentos → aguardando_confirmacao → fechado → avaliado`, mais `cancelado` e `sem_prestadores`.

Status do prestador (`providers[].status`): `sugerido | excluido | na_fila | sem_whatsapp | contatado | respondeu | orcou | sem_resposta | recusou | recusado_pelo_usuario | pausado | aprovado | fechado | dispensado`. (`recusou` = o prestador recusou; `recusado_pelo_usuario` = o usuário recusou o orçamento — novo no plano §3 F6.)

### `card` (campo `messages[].card`, guardado em `messages.card_json`)

Cards são ponteiros: o front desenha a partir de `providers`/`payment`/estado do WhatsApp ao vivo.

| kind | campos | uso |
|---|---|---|
| `diagnostico` | `profissao, resumo` | botão → `POST /search` |
| `providers` | — | toggles + "Chamar selecionados" → `POST /dispatch`. Também é reenviado quando um Pix expira ("gerar outro"). |
| `whatsapp` | — | QR de `GET /api/whatsapp` + `wa.status` |
| `payment` | `paymentId` | Pix (ou botão "simular" quando `provider === 'simulado'`) |
| `progress` | — | lista dos selecionados com status |
| `quote` | `rpId` | Aprovar / Recusar / Responder |
| `decision` | `rpId, pergunta` | pergunta do negociador; responder via `POST /quotes/:rpId/reply` |
| `paused` | `rpId` | "Retomar" → `POST /providers/:rpId/resume` |
| `rating` | `providerId, providerName` | estrelas → `POST /rating` |
| `comparison` | — | o resumo comparativo do F6 vem em `content` |
| `error` | — | `content` tem a mensagem pro usuário (ex.: falta `ANTHROPIC_API_KEY`) |

No card `diagnostico`, o texto da fala do agente ("Pra isso tu precisa de um eletricista…") vem no `content` da mesma mensagem.

## SSE (`GET /api/stream`)

`event:` = tipo; `data:` = JSON (sem o campo `type`). Ao conectar, o servidor manda um `wa.status` com o estado atual. Heartbeat `: ping` a cada 15s; `retry: 3000`.

| evento | data |
|---|---|
| `message.created` | `{ requestId, message }` (mesmo shape de `messages[]`; no fim do streaming do F1 inclui `streamId`) |
| `message.delta` | `{ requestId, messageId: "stream-<uuid>", text /* pedaço */ }` |
| `message.done` | `{ requestId, messageId }` — sempre emitido no fim do turno do F1, também em erro |
| `request.updated` | `{ requestId }` → refazer `GET /api/requests/:id` |
| `requests.changed` | `{}` → refazer `GET /api/requests` |
| `provider.updated` | `{ requestId, rpId }` (sempre acompanhado de `request.updated`) |
| `wa.status` | `{ status, qr, me }` (`qr` = PNG data URL quando `status === 'qr'`) |
| `wa.qr` | `{ qr }` (redundante com `wa.status`) |
| `payment.updated` | `{ requestId, paymentId, status }` |

Streaming do F1: os deltas usam um `messageId` temporário; quando o turno termina chega `message.created` com `message.streamId` igual a ele (substituir a bolha) e depois `message.done`. Se o F1 usar a tool e falar de novo, os deltas das duas chamadas chegam no mesmo `messageId`, sem separador; o `content` final é o certo. Em erro, o `message.created` é um `system_event` com card `error` (também com `streamId`).

## Desvios e decisões (em relação ao PLANO.md)

- **F1 → F2 em dois cliques**: `definir_diagnostico` grava o diagnóstico e posta o card `diagnostico`, mas o status continua `diagnostico`; a busca (status `buscando`) só começa em `POST /search`, que é o botão do card. O plano dizia as duas coisas; ficou o botão.
- **F1 com tool** faz uma segunda chamada (com o `tool_result`) pra o modelo dizer a frase de confirmação. O histórico nunca termina num `tool_use` sem resposta. Mensagens do usuário depois do disparo continuam indo pro F1, que recebe uma nota `system` com a etapa atual e não pode redefinir o diagnóstico.
- **Notas do app no meio da conversa**: F1 usa um turno `{role:'system'}` logo depois da mensagem do usuário (empurrão depois de 4 turnos; busca sem resultado). F5 usa turnos `user` com prefixo `[evento]`/`[usuário]`/`[prestador HH:MM]` (plano §3 atualizado).
- **Validação de WhatsApp**: se o WhatsApp está conectado na hora da busca, o F2 valida com `onWhatsApp` e mostra só quem tem. Se não está, mostra os 5 melhores sem validar e valida no disparo (quem não tem vira `sem_whatsapp`). Se nenhum selecionado tem WhatsApp, o pedido vai pra `sem_prestadores` e o valor volta como 1 crédito.
- **Fallback web do F2** ficou em dois passos (web_search → extração com `output_config.format`). Não deu pra testar se dá pra juntar num só (sem chave da API neste ambiente).
- **`DEV_TEST_PROVIDER_PHONE`**: entra como "Prestador de teste" (`source: 'teste'`, novo valor além de `google|web`), sempre na posição 0 e fora do limite de 5. Passa pelo `onWhatsApp` igual aos outros.
- **`shouldIgnoreJid`**: além dos PNs de prestadores ativos, **nunca ignora os JIDs da própria conta** (sem isso, a resposta manual do usuário pelo celular — que chega com `from` = o próprio aparelho — nunca seria vista e o `pausado` não funcionaria). LIDs desconhecidos não são ignorados (plano). Risco aceito: o Baileys responde com NACK (`UnhandledError`) às mensagens ignoradas; o celular do usuário continua recebendo normalmente.
- **Detecção de sessão salva**: só reconecta na subida se `data/wa-auth/creds.json` tem `me.id` (pareado). Um QR que expirou sem leitura apaga a pasta e volta pra `desconectado` sem ficar gerando QR em loop. (`creds.registered` fica `false` no login por QR nesta versão, então não serve pra isso.)
- **Eventos do Baileys**: `message-capping.update` e `connection.update.reachoutTimeLock` existem no rc14 e são tratados (pausam a outbox e avisam no chat). Também é consultado `fetchAccountReachoutTimelock()` ao conectar.
- **Pausado**: mensagens do prestador que chegam enquanto `pausado` ficam guardadas; ao retomar, o negociador recebe tudo junto, com o que o usuário escreveu à mão.
- **Lembrete (scheduler)** só pra prestadores em `contatado` (nunca responderam), 3h sem atividade, horário comercial 8h–20h de Brasília; 24h depois do lembrete → `sem_resposta`. O texto do lembrete é fixo (não gasta chamada de IA) e entra no histórico do negociador como `[evento]` no próximo turno.
- **Aprovar** um segundo orçamento devolve o primeiro aprovado pra `orcou` (um aprovado por vez). **Fechamento** dispensa os outros em aberto com um "obrigado, já resolvi" e tira da fila quem ainda não tinha sido contatado.
- **Follow-up F7** é idempotente pela coluna nova `requests.followup_sent_at`.
- **Colunas extras** (não estavam no §2): `requests.followup_sent_at`; `request_providers.position, last_inbound_at, call_reply_sent_at, paused_from`; `wa_messages.proto_json` (pro `getMessage` dos retries); `outbox.failed_at, error, attempts`; `agent_state.pending_json`.
- **Mercado Pago**: `payer.email` vem de `settings.user_email`, com fallback em `MP_PAYER_EMAIL` (.env). CPF não é enviado (não verificado contra a API real).
