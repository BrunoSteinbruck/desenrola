# Desenrola — padrão visual ("Céu de verão")

Decidido pelo Bruno em 2026-11-07. Substitui o grafite com liquid glass e o verde `#1f7a4d` da V1.
Canvas de referência (linha D): https://claude.ai/artifact/RvsTdvSYk3zqrYtqqBPi5o
Já aplicado em `web/src/styles.css` (variáveis no `:root`) e no admin. O vídeo (`video/`) segue no visual antigo até o Bruno pedir um novo.

## Por que esse visual

- **Público principal:** 18 a 30 anos, que não tem intimidade com problemas de casa e não quer chamar desconhecido no WhatsApp. Também atende o secundário: mulheres de 25 a 50 que não querem botar a mão na massa.
- **Personalidade:** simplifica a vida. Amigável, confiável, simples. Nunca confuso nem sufocante.
- **Referências:** Airbnb (espaço em branco, uma cor de marca, cantos arredondados), iFood no marketing e o site da Post Op (azul céu com marinho, preço grande, etiquetas em fonte mono).
- **Anti-referência:** GetNinjas (tela cheia de informação, laranja e amarelo).

## Cores

| Token (`styles.css`) | Hex | Uso |
|---|---|---|
| `--sky` | `#7AB8F5` | cor da marca: ícone, foto do WhatsApp, destaques grandes, balão do assistente. **Nunca com texto branco por cima** (usar marinho). |
| `--navy` / `--ink` | `#0E1626` | texto e ação principal (Aprovar, Pedir orçamentos, Enviar), com texto branco |
| `--blue` / `--accent` | `#2563C4` | números em destaque, links, botões dos templates no WhatsApp |
| `--sky-soft` | `#E8F2FD` | cartões e caixas de destaque (borda `--sky-edge` `#C9DFF7`) |
| `--bg` | `#F3F7FC` | fundo do app ("Névoa") |
| `--surface` | `#FFFFFF` | cartões, caixas de texto |
| `--line` | `#DCE6F2` | divisórias e bordas |
| `--muted` | `#4A5568` | texto secundário |
| `--faint` | `#6B7A90` | placeholder e texto terciário |
| `--danger` | `#B4321F` | erro |
| topo do site | `#0B1019` + degradê 120° `#5FA6F0 → #94C6F8 → #D8EBFE` | só na entrada do site (marketing) |

**Não usar:**
- **verde:** confunde com o WhatsApp e com o Pix;
- **laranja e amarelo:** lembram o GetNinjas.

## Tipografia

- **Inter Tight 700/800** (`--font-head`): títulos, preços e logo. Bem apertada (`letter-spacing: -0.03em`).
- **Inter** (`--font`): textos e interface.
- **IBM Plex Mono 500** (`--font-mono`): etiquetas pequenas em maiúsculas com espaçamento, por exemplo `PEDIDO #128 · CIDADE BAIXA`.

## Recursos visuais

- **Botões:** a ação principal é marinho com texto branco. No site, o botão é retangular e tem seta. No app, o botão é pill.
- **Preço:** grande em Inter Tight, dentro de uma caixa azul clarinha.
- **Cantos:** pouco arredondados no site; mais arredondados no app (cartões ~20px, painéis 22px).
- **Sombras:** suaves e azuladas (`--shadow-card`). Nada de blur ou vidro.
- **Caixa de texto da home:** um feixe de luz azul corre pela borda (*border beam*). Quando a pessoa começa a digitar, o feixe para e a linha cresce pros dois lados até fechar a borda.
- **Título da home:** "Qual problema você precisa resolver?".
- **Fora do padrão:** a palavra destacada em bloco marinho com texto branco. O Bruno tirou esse recurso em 2026-11-07.
- **Sem:** emoji, degradê no app (só na entrada do site) e tela poluída.

## Logo (provisório)

O nome "desenrola" vai em minúsculo, em Inter Tight 800. O ícone é um fio enrolado que vira uma linha reta e termina num ponto: o problema embolado que se desenrola. Ele aparece em marinho sobre um quadrado ou círculo azul céu, e é o mesmo no ícone do app e na foto do WhatsApp oficial.
**Vai ser retrabalhado.** Não tratar como final.

## Direções descartadas (pra não voltar a elas)

- **A · Coral de casa** (coral com creme): não foi escolhida.
- **B · Azul piscina** (azul `#1E9BD7` com areia): o Bruno gostou do azul, mas achou a paleta estranha. A D é a evolução dela.
- **C · Maracujá** (amarelo com preto): ficou igual ao GetNinjas.
