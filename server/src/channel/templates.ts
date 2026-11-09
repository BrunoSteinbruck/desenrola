// Templates do WhatsApp (mensagens que NÓS iniciamos). Fonte única: daqui sai o texto que vai pra
// aprovação da Meta (scripts/whatsapp-templates.ts) e daqui o outbox valida as variáveis.
//
// Regras que a Meta cobra (ver PLANO-V2 §3.3):
// - utility = notificação de algo que a pessoa pediu/assinou; nada de tom promocional, senão vira marketing (~9× mais caro);
// - nenhum template é genérico: todos citam o pedido;
// - nunca começa nem termina com variável; variáveis sem quebra de linha, tab ou espaço duplo;
// - nenhum template "apresenta o assistente virtual" (a Meta usa isso como exemplo de marketing).

export type TemplateCategory = 'utility' | 'authentication' | 'marketing';

export type TemplateDef = {
  category: TemplateCategory;
  /** corpo com {{1}}, {{2}}…; a ordem segue `vars` */
  body: string;
  /** nomes das variáveis, na ordem de {{1}}… (usados pelo código, não vão pra Meta) */
  vars: readonly string[];
  /** exemplos pra aprovação */
  samples: readonly string[];
  /** botões de resposta rápida (id volta no webhook como ButtonPayload) */
  buttons?: readonly { id: string; title: string }[];
  /**
   * false = pode ir pra quem ainda não confirmou o opt-in. Só os que SÃO o pedido de confirmação
   * ou que a pessoa acabou de solicitar (código de login).
   */
  requiresOptIn: boolean;
  /** só sai com a conversa aberta (24h): tem variável nos botões, então nunca vai pra aprovação da Meta */
  sessionOnly?: boolean;
};

export const TEMPLATES = {
  codigo_verificacao: {
    category: 'authentication',
    body: '{{1}} é o teu código de verificação.', // corpo fixo da Meta pra authentication; só o código varia
    vars: ['codigo'],
    samples: ['482913'],
    requiresOptIn: false,
  },
  boas_vindas: {
    category: 'utility',
    body: 'Olá, {{1}}! Aqui é o Desenrola. Como combinamos, este número vai te mandar pedidos de orçamento de {{2}} em {{3}}. Confirma que quer receber esses pedidos por aqui?',
    vars: ['nome', 'categoria', 'regiao'],
    samples: ['Marcos', 'eletricista', 'Cidade Baixa e Bom Fim'],
    buttons: [
      { id: 'optin_sim', title: 'Quero receber' },
      { id: 'optin_nao', title: 'Não quero' },
    ],
    requiresOptIn: false,
  },
  pedido_novo: {
    category: 'utility',
    // "Posso atender" abre a conversa: o agente manda tudo que o cliente contou e pede valor e data.
    // Quem preferir pode responder direto com o valor, sem tocar no botão.
    body: 'Pedido #{{1}}: {{2}} em {{3}}\nRelato do cliente: "{{4}}"\n\nSe puder atender, toca em Posso atender.',
    vars: ['pedido', 'categoria', 'bairro', 'relato'],
    samples: ['128', 'eletricista', 'Cidade Baixa', 'o disjuntor ta desarmando o tempo todo'],
    buttons: [
      { id: 'posso_atender', title: 'Posso atender' },
      { id: 'agora_nao', title: 'Agora não' },
      { id: 'parar', title: 'Parar de receber' },
    ],
    requiresOptIn: true,
  },
  qual_pedido: {
    category: 'utility',
    body: 'Essa mensagem é sobre qual pedido?\n#{{1}}: {{2}}\n#{{3}}: {{4}}',
    vars: ['pedido_a', 'relato_a', 'pedido_b', 'relato_b'],
    samples: ['3', 'chuveiro sem sinal de vida', '2', 'disjuntor desarmando'],
    buttons: [
      { id: 'pedido_{{1}}', title: 'Pedido #{{1}}' },
      { id: 'pedido_{{3}}', title: 'Pedido #{{3}}' },
    ],
    requiresOptIn: true,
    sessionOnly: true,
  },
  prestador_lembrete: {
    category: 'utility',
    body: 'O pedido #{{1}} ({{2}} em {{3}}) ainda está sem orçamento. Se puder atender, responde aqui com um valor aproximado e qual data poderia ir.',
    vars: ['pedido', 'categoria', 'bairro'],
    samples: ['128', 'eletricista', 'Cidade Baixa'],
    buttons: [{ id: 'agora_nao', title: 'Agora não' }],
    requiresOptIn: true,
  },
  pergunta_do_cliente: {
    category: 'utility',
    body: 'Pedido #{{1}}\nResposta do cliente: "{{2}}"\n\nSe tiver mais alguma dúvida, é só responder aqui.',
    vars: ['pedido', 'resposta'],
    samples: ['128', 'pode vir amanhã depois das 14h'],
    requiresOptIn: true,
  },
  orcamento_aprovado: {
    category: 'utility',
    body: 'Boa notícia! O cliente aprovou teu orçamento de {{2}} no pedido #{{1}}.\nContato: {{3}}, {{4}}, {{5}}.\nCombina a data e o horário direto com o cliente.',
    vars: ['pedido', 'valor', 'nome_cliente', 'telefone_cliente', 'bairro'],
    samples: ['128', 'R$ 80,00', 'Bruno', '(51) 99999-8888', 'Cidade Baixa'],
    requiresOptIn: true,
  },
  pedido_encerrado: {
    category: 'utility',
    body: 'O pedido #{{1}} de {{2}} foi encerrado: {{3}}. Obrigado pela atenção, os próximos pedidos continuam chegando por aqui.',
    vars: ['pedido', 'categoria', 'motivo'],
    samples: ['128', 'eletricista', 'o cliente escolheu outro orçamento'],
    requiresOptIn: true,
  },
  cliente_orcamento_chegou: {
    category: 'utility',
    // o orçamento vem inteiro aqui e dá pra decidir sem abrir o site
    body: 'Chegou orçamento pro teu pedido "{{1}}":\n{{2}}: {{3}}\n{{4}}\n\nPra fechar, toca em Aprovar: teu nome e celular vão pro profissional combinar o horário. Se quiser perguntar algo, é só responder aqui.',
    vars: ['titulo', 'profissional', 'valor', 'detalhes'],
    samples: ['Chuveiro não esquenta', 'Marcos Eletricista', 'R$ 80,00', 'Troca da resistência com a peça · amanhã a partir das 14h'],
    buttons: [
      { id: 'aprovar', title: 'Aprovar' },
      { id: 'recusar', title: 'Recusar' },
    ],
    requiresOptIn: true,
  },
  cliente_pergunta_prestador: {
    category: 'utility',
    body: 'Um profissional tem uma dúvida sobre teu pedido "{{1}}":\n"{{2}}"\nPode responder aqui mesmo que eu repasso.',
    vars: ['titulo', 'pergunta'],
    samples: ['Chuveiro não esquenta', 'o chuveiro é de 220V?'],
    requiresOptIn: true,
  },
  cliente_avaliacao: {
    category: 'utility',
    body: 'Como foi o serviço do {{1}} no teu pedido "{{2}}"? Tua nota ajuda a gente a indicar os melhores profissionais.',
    vars: ['profissional', 'titulo'],
    samples: ['Marcos Eletricista', 'Chuveiro não esquenta'],
    buttons: [
      { id: 'nota_5', title: 'Ótimo' },
      { id: 'nota_3', title: 'Razoável' },
      { id: 'nota_1', title: 'Ruim' },
    ],
    requiresOptIn: true,
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateKey = keyof typeof TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

/** SID do Content aprovado na Twilio: env WA_TPL_<KEY> (ex.: WA_TPL_PEDIDO_NOVO=HX…). */
export const contentSidFor = (key: TemplateKey) => process.env[`WA_TPL_${key.toUpperCase()}`] || null;

/** A Meta recusa parâmetro com quebra de linha, tab, 4+ espaços seguidos ou vazio. */
export function sanitizeVar(v: string, max = 200): string {
  const s = v.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const cut = s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  return cut || '-';
}

/** Valida e monta as variáveis no formato da Twilio ({"1": "...", "2": "..."}). */
export function buildVars(key: TemplateKey, values: Record<string, string>): Record<string, string> {
  const def: TemplateDef = TEMPLATES[key];
  const out: Record<string, string> = {};
  def.vars.forEach((name, i) => {
    const v = values[name];
    if (v == null) throw new Error(`Template ${key}: falta a variável "${name}"`);
    out[String(i + 1)] = sanitizeVar(String(v));
  });
  return out;
}

/** Texto final como a pessoa vai ler (log, admin, testes). */
export function renderTemplate(key: TemplateKey, vars: Record<string, string>) {
  return TEMPLATES[key].body.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] ?? `{{${n}}}`);
}
