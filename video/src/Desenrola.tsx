import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Audio, Easing, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, C, Caret, Check, Cursor, Dots, Enter, fontFamily, glass, Kicker, Star, typed, useExit } from './ui';

// [início, duração] de cada cena, em frames (30 fps)
const S = {
  problema: [0, 165],
  logo: [165, 90],
  pergunta: [255, 150],
  diagnostico: [405, 135],
  busca: [540, 180],
  whatsapp: [720, 300],
  orcamento: [1020, 165],
  avaliacao: [1185, 105],
  final: [1290, 135],
} as const;
export const TOTAL = 1425;

export const Desenrola = () => (
  <AbsoluteFill style={{ fontFamily, color: C.ink }}>
    <Backdrop />
    <Audio src={staticFile('trilha.wav')} />
    <Scene k="problema"><Problema /></Scene>
    <Scene k="logo"><Logo /></Scene>
    <Scene k="pergunta"><Pergunta /></Scene>
    <Scene k="diagnostico"><Diagnostico /></Scene>
    <Scene k="busca"><Busca /></Scene>
    <Scene k="whatsapp"><WhatsApp /></Scene>
    <Scene k="orcamento"><Orcamento /></Scene>
    <Scene k="avaliacao"><Avaliacao /></Scene>
    <Scene k="final"><Final /></Scene>
  </AbsoluteFill>
);

const Scene = ({ k, children }: { k: keyof typeof S; children: ReactNode }) => {
  const [from, dur] = S[k];
  return (
    <Sequence from={from} durationInFrames={dur}>
      <Fade dur={dur} last={k === 'final'}>{children}</Fade>
    </Sequence>
  );
};

const Fade = ({ dur, last, children }: { dur: number; last?: boolean; children: ReactNode }) => {
  const out = useExit(dur, last ? 1 : 12);
  return <AbsoluteFill style={{ opacity: last ? 1 : out }}>{children}</AbsoluteFill>;
};

/** Duas colunas: legenda à esquerda, peça da interface à direita. */
const Split = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <AbsoluteFill style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', padding: '0 140px', gap: 100 }}>
    <div style={{ flex: '0 0 640px' }}>{left}</div>
    <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center' }}>{right}</div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------- 1. o problema
const CHATS: { who: string; text: string; x: number; y: number; at: number }[] = [
  { who: 'Encanador', text: 'Oi, faz orçamento?', x: 1180, y: 120, at: 18 },
  { who: 'Eletricista', text: 'Alguém aí??', x: 1460, y: 300, at: 28 },
  { who: 'Mecânico', text: 'Me liga quando puder', x: 1120, y: 420, at: 38 },
  { who: 'Faz-tudo', text: 'visto por último às 14:02', x: 1480, y: 560, at: 46 },
  { who: 'Encanador 2', text: 'Quanto fica a visita?', x: 1150, y: 700, at: 54 },
  { who: 'Eletricista 2', text: 'Só amanhã, ok?', x: 1500, y: 820, at: 61 },
  { who: 'Chaveiro', text: 'Manda foto?', x: 1240, y: 900, at: 67 },
  { who: 'Pintor', text: '…', x: 1640, y: 160, at: 72 },
];

const Problema = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const count = CHATS.filter((c) => f >= c.at).length;
  const tarde = spring({ frame: f - 100, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill>
      {CHATS.map((c, i) => {
        const s = spring({ frame: f - c.at, fps, config: { damping: 11, mass: 0.6 } });
        const float = Math.sin((f + i * 17) / 14) * 6;
        const blur = interpolate(f, [100, 130], [0, 6], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: c.x, top: c.y + float, transform: `scale(${s})`, transformOrigin: 'left center',
              opacity: interpolate(f, [100, 130], [1, 0.35], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
              filter: `blur(${blur}px)`,
              background: '#fff', borderRadius: 22, padding: '14px 22px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', minWidth: 260,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: C.accent, marginBottom: 4 }}>{c.who}</div>
            <div style={{ fontSize: 26, color: C.ink2 }}>{c.text}</div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 140, top: 300, width: 900 }}>
        <Enter at={0}>
          <h1 style={{ margin: 0, fontSize: 92, lineHeight: 1.02, fontWeight: 700, letterSpacing: -4 }}>Consertar uma coisa em casa</h1>
        </Enter>
        <Enter at={12}>
          <p style={{ margin: '28px 0 0', fontSize: 40, color: C.muted }}>
            = <span style={{ color: C.ink, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{count}</span> conversas no WhatsApp
          </p>
        </Enter>
        <div style={{ marginTop: 40, opacity: tarde, transform: `translateY(${(1 - tarde) * 30}px)` }}>
          <span style={{ fontSize: 56, fontWeight: 600, letterSpacing: -1.5, color: C.ink, background: 'rgba(255,255,255,0.7)', padding: '8px 20px', borderRadius: 16 }}>
            uma tarde inteira perdida.
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 2. logo
const Logo = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 13, mass: 0.8 } });
  const shine = interpolate(f, [10, 45], [-60, 160], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ ...glass, position: 'relative', overflow: 'hidden', borderRadius: 48, padding: '70px 110px', transform: `scale(${0.85 + s * 0.15})`, opacity: s, textAlign: 'center' }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${shine}%`, width: 120, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)', transform: 'skewX(-20deg)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, justifyContent: 'center' }}>
          <span style={{ width: 26, height: 26, borderRadius: '50%', background: C.accent, boxShadow: '0 0 0 10px rgba(31,122,77,0.15)' }} />
          <span style={{ fontSize: 120, fontWeight: 700, letterSpacing: -5 }}>Desenrola</span>
        </div>
        <Enter at={18}>
          <p style={{ margin: '18px 0 0', fontSize: 34, color: C.muted }}>Eu faço o meio de campo com os prestadores. Tu só aprova.</p>
        </Enter>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 3. a pergunta
const PROBLEMA = 'o chuveiro parou de esquentar, só sai água fria';
const Pergunta = () => {
  const f = useCurrentFrame();
  const text = typed(PROBLEMA, f, 30, 26);
  const done = text.length === PROBLEMA.length;
  const press = interpolate(f, [125, 130, 136], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 50 }}>
      <Enter at={0}>
        <h1 style={{ margin: 0, fontSize: 76, fontWeight: 600, letterSpacing: -3 }}>Qual problema você quer resolver hoje?</h1>
      </Enter>
      <Enter at={8}>
        <div style={{ ...glass, width: 1250, borderRadius: 44, padding: '34px 30px 30px 44px', display: 'flex', alignItems: 'flex-end', gap: 20, background: 'rgba(255,255,255,0.62)' }}>
          <div style={{ flex: 1, fontSize: 40, lineHeight: 1.4, minHeight: 112, color: text ? C.ink : C.faint }}>
            {text || 'Descreve o problema'}
            {!done && f > 20 && <Caret />}
          </div>
          <div style={{ width: 76, height: 76, borderRadius: '50%', background: done ? C.ink : '#b9b8b3', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 - press * 0.12})`, boxShadow: '0 8px 20px rgba(0,0,0,0.18)' }}>
            <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </div>
        </div>
      </Enter>
      <Enter at={20}>
        <p style={{ margin: 0, fontSize: 28, color: C.muted }}>Escreve do teu jeito. Sem formulário.</p>
      </Enter>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 4. diagnóstico
const DIAG = 'Pra isso tu precisa de um eletricista. Deve ser a resistência. Quer que eu chame os da tua região?';
const Diagnostico = () => {
  const f = useCurrentFrame();
  const thinking = f >= 22 && f < 58;
  const reply = typed(DIAG, f, 58, 55);
  return (
    <Split
      left={<Kicker at={0} step="1 · Diagnóstico" title="Entende o problema na hora" sub="Grátis, antes de chamar qualquer pessoa." />}
      right={
        <div style={{ ...glass, width: 860, borderRadius: 36, padding: 44, display: 'flex', flexDirection: 'column', gap: 30 }}>
          <Enter at={6} style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
            <div style={{ background: 'rgba(27,27,25,0.9)', color: '#fff', fontSize: 30, lineHeight: 1.45, padding: '18px 26px', borderRadius: 30 }}>{PROBLEMA}</div>
          </Enter>
          {thinking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28, color: C.muted }}>
              <Dots /> Pensando…
            </div>
          )}
          {f >= 58 && <p style={{ margin: 0, fontSize: 32, lineHeight: 1.5 }}>{reply}</p>}
          {f >= 105 && (
            <Enter at={105}>
              <span style={{ display: 'inline-block', background: C.ink, color: '#fff', fontSize: 26, fontWeight: 500, padding: '16px 30px', borderRadius: 999 }}>Procurar eletricista</span>
            </Enter>
          )}
        </div>
      }
    />
  );
};

// ---------------------------------------------------------------- 5. busca
const PROVS = [
  { name: 'Elétrica Moinhos', tag: '4,9 no Desenrola', ours: true },
  { name: 'Marcos Eletricista', tag: '4,8 no Desenrola', ours: true },
  { name: 'JR Instalações', tag: '4,7 no Desenrola', ours: true },
  { name: 'Luz & Força Serviços', tag: 'Novo · Google 4,6', ours: false },
  { name: 'Paulo Reparos Elétricos', tag: 'Novo · Google 4,5', ours: false },
];
const Busca = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const glow = interpolate(f, [130, 150, 170], [0, 1, 0.6], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Split
      left={<Kicker at={0} step="2 · Busca" title="Acha os melhores da tua região" sub="3 que já atenderam bem quem usa o Desenrola + 2 novos do Google." />}
      right={
        <div style={{ ...glass, width: 900, borderRadius: 36, overflow: 'hidden' }}>
          {PROVS.map((p, i) => {
            const at = 14 + i * 12;
            const s = spring({ frame: f - at, fps, config: { damping: 15 } });
            const checked = f >= at + 14;
            return (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '28px 36px', borderBottom: '1.5px solid rgba(0,0,0,0.05)', opacity: s, transform: `translateX(${(1 - s) * 60}px)` }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: checked ? C.ink : 'transparent', border: `2.5px solid ${C.ink}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {checked && <Check size={22} />}
                </div>
                <span style={{ flex: 1, fontSize: 32, fontWeight: 500 }}>{p.name}</span>
                <span style={{ fontSize: 22, fontWeight: 600, padding: '8px 16px', borderRadius: 999, background: p.ours ? 'rgba(31,122,77,0.12)' : 'rgba(0,0,0,0.06)', color: p.ours ? C.accent : C.muted }}>{p.tag}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 36px' }}>
            <span style={{ fontSize: 24, color: C.muted }}>5 selecionados</span>
            <span style={{ background: C.ink, color: '#fff', fontSize: 26, fontWeight: 500, padding: '16px 30px', borderRadius: 999, boxShadow: `0 0 0 ${glow * 10}px rgba(31,122,77,${0.25 * glow})` }}>Chamar no WhatsApp</span>
          </div>
        </div>
      }
    />
  );
};

// ---------------------------------------------------------------- 6. WhatsApp
type Msg = { side: 'out' | 'in'; text: string; typeAt: number; at: number };
const MSGS: Msg[] = [
  { side: 'out', text: 'oi, tudo bem? moro aqui na cidade baixa', typeAt: 18, at: 40 },
  { side: 'out', text: 'o chuveiro parou de esquentar, só sai água fria (provavelmente a resistência)', typeAt: 55, at: 82 },
  { side: 'out', text: 'tu faz esse conserto? mais ou menos quanto fica?', typeAt: 97, at: 122 },
  { side: 'in', text: 'faço sim! a troca da resistência fica 80 com a peça', typeAt: 145, at: 182 },
  { side: 'in', text: 'consigo ir amanhã às 15h', typeAt: 194, at: 216 },
  { side: 'out', text: 'beleza, deixa eu ver aqui e já te falo', typeAt: 234, at: 258 },
];
const WhatsApp = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const typingIn = MSGS.some((m) => m.side === 'in' && f >= m.typeAt && f < m.at);
  const typingOut = MSGS.find((m) => m.side === 'out' && f >= m.typeAt && f < m.at);
  const phone = spring({ frame: f - 4, fps, config: { damping: 16 } });
  return (
    <Split
      left={<Kicker at={0} step="3 · Conversa" title="Chama no teu WhatsApp, do teu jeito" sub="Mensagens curtas, uma de cada vez, como tu escreveria. Nada é fechado sem tu aprovar." />}
      right={
        <div style={{ width: 470, height: 920, borderRadius: 64, background: '#111', padding: 14, boxShadow: '0 40px 90px rgba(0,0,0,0.25)', transform: `translateY(${(1 - phone) * 80}px) rotate(${(1 - phone) * 4}deg)`, opacity: phone }}>
          <div style={{ width: '100%', height: '100%', borderRadius: 52, overflow: 'hidden', background: C.waBg, display: 'flex', flexDirection: 'column' }}>
            <div style={{ background: '#f6f6f6', padding: '58px 24px 18px', display: 'flex', alignItems: 'center', gap: 14, borderBottom: '1px solid #e2e2e2' }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#c9d8cf', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: C.accent }}>EM</div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 600 }}>Elétrica Moinhos</div>
                <div style={{ fontSize: 18, color: typingIn ? C.accent : C.faint }}>{typingIn ? 'digitando…' : 'online'}</div>
              </div>
            </div>
            <div style={{ flex: 1, padding: '20px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10 }}>
              {MSGS.filter((m) => f >= m.at).map((m, i) => {
                const s = spring({ frame: f - m.at, fps, config: { damping: 14, mass: 0.5 } });
                return (
                  <div key={i} style={{ alignSelf: m.side === 'out' ? 'flex-end' : 'flex-start', maxWidth: '82%', background: m.side === 'out' ? C.wa : '#fff', borderRadius: 18, padding: '11px 16px', fontSize: 22, lineHeight: 1.35, boxShadow: '0 1px 1px rgba(0,0,0,0.08)', transform: `scale(${0.8 + 0.2 * s})`, opacity: s, transformOrigin: m.side === 'out' ? 'right bottom' : 'left bottom' }}>
                    {m.text}
                    <span style={{ fontSize: 14, color: '#8a8a8a', marginLeft: 10 }}>14:3{Math.min(9, i + 2)}{m.side === 'out' ? ' ✓✓' : ''}</span>
                  </div>
                );
              })}
              {typingOut && (
                <div style={{ alignSelf: 'flex-end', background: C.wa, borderRadius: 18, padding: '14px 18px' }}>
                  <Dots color="#7a9a80" size={9} />
                </div>
              )}
            </div>
            <div style={{ background: '#f6f6f6', padding: '14px 18px 34px' }}>
              <div style={{ background: '#fff', borderRadius: 999, padding: '14px 22px', fontSize: 20, color: '#9a9a9a' }}>Mensagem</div>
            </div>
          </div>
        </div>
      }
    />
  );
};

// ---------------------------------------------------------------- 7. orçamento
const Orcamento = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ease = Easing.inOut(Easing.cubic);
  const cx = interpolate(f, [30, 70], [1700, 1035], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  const cy = interpolate(f, [30, 70], [980, 640], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  const press = interpolate(f, [74, 79, 86], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const done = spring({ frame: f - 86, fps, config: { damping: 12 } });
  const ring = interpolate(f, [86, 116], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const card: CSSProperties = { ...glass, borderRadius: 36, padding: 40, display: 'flex', flexDirection: 'column', gap: 22 };
  return (
    <AbsoluteFill>
      <Split
        left={<Kicker at={0} step="4 · Tu decide" title="Os orçamentos chegam pra ti aprovar" sub="Ele compara, mas quem fecha é tu. Os outros recebem um obrigado." />}
        right={
          <div style={{ position: 'relative', width: 820, height: 520 }}>
            <Enter at={12} style={{ position: 'absolute', left: 60, top: -40, right: -40, opacity: 0.6, transform: 'scale(0.94)' }}>
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30 }}>
                  <span style={{ fontWeight: 500 }}>Luz &amp; Força Serviços</span>
                  <span style={{ fontWeight: 700 }}>R$ 120</span>
                </div>
                <span style={{ fontSize: 24, color: C.muted }}>Sexta de manhã</span>
              </div>
            </Enter>
            <Enter at={4} style={{ position: 'absolute', left: 0, right: 0, top: 150 }}>
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 34, fontWeight: 600 }}>Elétrica Moinhos</span>
                  <span style={{ fontSize: 54, fontWeight: 700, letterSpacing: -2 }}>R$ 80</span>
                </div>
                <span style={{ fontSize: 26, color: C.ink2 }}>Troca da resistência com a peça · amanhã às 15h</span>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 6 }}>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', inset: -ring * 30, borderRadius: 999, border: `3px solid rgba(31,122,77,${(1 - ring) * 0.6})` }} />
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, background: C.accent, color: '#fff', fontSize: 28, fontWeight: 600, padding: '18px 34px', borderRadius: 999, transform: `scale(${1 - press * 0.08})`, boxShadow: '0 8px 20px rgba(31,122,77,0.3)' }}>
                      {done > 0.05 && <span style={{ transform: `scale(${done})`, display: 'inline-flex' }}><Check size={26} /></span>}
                      {f >= 86 ? 'Fechado' : 'Aprovar'}
                    </span>
                  </div>
                  {f < 86 && <span style={{ fontSize: 26, color: C.ink, background: 'rgba(255,255,255,0.7)', padding: '18px 30px', borderRadius: 999 }}>Responder</span>}
                  {f >= 92 && (
                    <Enter at={92}>
                      <span style={{ fontSize: 26, color: C.accent, fontWeight: 500 }}>Amanhã, 15h · confirmado com ele</span>
                    </Enter>
                  )}
                </div>
              </div>
            </Enter>
          </div>
        }
      />
      {f >= 30 && <Cursor x={cx} y={cy} press={press} />}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 8. avaliação
const Avaliacao = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 40 }}>
      <Enter at={0}>
        <div style={{ ...glass, borderRadius: 40, padding: '50px 70px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
          <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: -1 }}>Como foi o serviço da Elétrica Moinhos?</span>
          <div style={{ display: 'flex', gap: 14 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Star key={i} size={84} on={spring({ frame: f - 14 - i * 6, fps, config: { damping: 9, mass: 0.5 } })} />
            ))}
          </div>
        </div>
      </Enter>
      <Enter at={46}>
        <p style={{ margin: 0, fontSize: 32, color: C.muted }}>Cada nota melhora as próximas indicações.</p>
      </Enter>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 9. final
const Final = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mark = spring({ frame: f - 38, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 60, textAlign: 'center' }}>
      <div>
        <Enter at={0}>
          <h1 style={{ margin: 0, fontSize: 104, fontWeight: 700, letterSpacing: -4.5, lineHeight: 1.02 }}>Resolve teu problema</h1>
        </Enter>
        <Enter at={10}>
          <h1 style={{ margin: 0, fontSize: 104, fontWeight: 700, letterSpacing: -4.5, lineHeight: 1.02, color: C.muted }}>sem perder a tarde no WhatsApp.</h1>
        </Enter>
      </div>
      <div style={{ ...glass, borderRadius: 999, padding: '22px 46px', display: 'flex', alignItems: 'center', gap: 18, opacity: mark, transform: `scale(${0.9 + 0.1 * mark})` }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: C.accent, boxShadow: '0 0 0 8px rgba(31,122,77,0.15)' }} />
        <span style={{ fontSize: 48, fontWeight: 700, letterSpacing: -1.5 }}>Desenrola</span>
      </div>
    </AbsoluteFill>
  );
};
