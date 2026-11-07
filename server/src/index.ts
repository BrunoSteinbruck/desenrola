// Sobe o servidor: monta o app, liga o canal oficial e os agentes, e escuta.
import { buildApp, wireMarketplace } from './app.ts';
import { hasClaude } from './agents/claude.ts';
import { recoverNegotiations } from './agents/negociador.ts';
import { startScheduler } from './services/scheduler.ts';
import { startChannel } from './channel/index.ts';

const app = await buildApp();
wireMarketplace();
if (!hasClaude()) app.log.warn('ANTHROPIC_API_KEY não configurada: os agentes vão responder com erro no chat.');
recoverNegotiations();
startScheduler();
startChannel(app.log);

const port = Number(process.env.PORT) || 3333;
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}
