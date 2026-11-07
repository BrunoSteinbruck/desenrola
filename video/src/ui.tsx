// Peças visuais no estilo do app: Grafite com liquid glass.
import type { CSSProperties, ReactNode } from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';

export const { fontFamily } = loadFont('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin', 'latin-ext'] });

export const C = {
  bg: '#eceeec',
  ink: '#1b1b19',
  ink2: '#3f3e3a',
  muted: '#55544f',
  faint: '#7f7e78',
  accent: '#1f7a4d',
  wa: '#d9fdd3',
  waBg: '#efeae2',
};

export const glass: CSSProperties = {
  background: 'rgba(255,255,255,0.55)',
  backdropFilter: 'blur(28px) saturate(180%)',
  WebkitBackdropFilter: 'blur(28px) saturate(180%)',
  border: '1.5px solid rgba(255,255,255,0.9)',
  boxShadow: '0 24px 70px rgba(24,32,26,0.10), inset 0 1.5px 0 rgba(255,255,255,1)',
};

/** Fundo com manchas suaves que se mexem devagar (o que o vidro refrata). */
export const Backdrop = () => {
  const f = useCurrentFrame();
  const drift = (a: number, s: number) => Math.sin(f / s + a) * 40;
  const blob = (style: CSSProperties) => <div style={{ position: 'absolute', borderRadius: '50%', ...style }} />;
  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden' }}>
      {blob({ left: -200 + drift(0, 90), top: -260 + drift(1, 110), width: 1100, height: 800, background: '#d4e5d9', filter: 'blur(120px)' })}
      {blob({ right: -180 + drift(2, 100), bottom: -320 + drift(3, 120), width: 1000, height: 820, background: '#e9e1d2', filter: 'blur(130px)' })}
      {blob({ right: 420 + drift(4, 80), top: 120 + drift(5, 95), width: 420, height: 340, background: '#dde2ec', filter: 'blur(100px)' })}
    </div>
  );
};

/** Entrada com mola: sobe e aparece. */
export const useEnter = (start: number, damping = 18) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - start, fps, config: { damping, mass: 0.7 } });
  return { opacity: interpolate(f - start, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), y: (1 - s) * 40, s };
};

export const Enter = ({ at, children, style, from = 40 }: { at: number; children: ReactNode; style?: CSSProperties; from?: number }) => {
  const { opacity, s } = useEnter(at);
  return <div style={{ opacity, transform: `translateY(${(1 - s) * from}px)`, ...style }}>{children}</div>;
};

/** Saída suave no fim da cena. */
export const useExit = (end: number, len = 12) => {
  const f = useCurrentFrame();
  return interpolate(f, [end - len, end], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) });
};

/** Texto sendo digitado. */
export const typed = (text: string, frame: number, start: number, cps = 22, fps = 30) => {
  const n = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  return text.slice(0, Math.min(n, text.length));
};

export const Caret = () => {
  const f = useCurrentFrame();
  return <span style={{ display: 'inline-block', width: 3, height: '1.05em', marginLeft: 3, background: C.ink, verticalAlign: '-0.15em', opacity: Math.floor(f / 15) % 2 ? 0 : 1 }} />;
};

export const Dots = ({ color = C.faint, size = 10 }: { color?: string; size?: number }) => {
  const f = useCurrentFrame();
  return (
    <span style={{ display: 'inline-flex', gap: size * 0.6 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: size, height: size, borderRadius: '50%', background: color, opacity: 0.3 + 0.7 * Math.max(0, Math.sin((f - i * 5) / 5)) }} />
      ))}
    </span>
  );
};

/** Legenda de cena: título grande à esquerda. */
export const Kicker = ({ at, step, title, sub }: { at: number; step: string; title: string; sub?: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640 }}>
    <Enter at={at}>
      <span style={{ fontSize: 24, fontWeight: 600, color: C.accent, letterSpacing: 2, textTransform: 'uppercase' }}>{step}</span>
    </Enter>
    <Enter at={at + 4}>
      <h2 style={{ margin: 0, fontSize: 68, lineHeight: 1.05, fontWeight: 600, letterSpacing: -2.5, color: C.ink }}>{title}</h2>
    </Enter>
    {sub && (
      <Enter at={at + 9}>
        <p style={{ margin: 0, fontSize: 30, lineHeight: 1.4, color: C.muted }}>{sub}</p>
      </Enter>
    )}
  </div>
);

export const Check = ({ size = 22, color = '#fff' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const Star = ({ on, size = 64 }: { on: number; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z" fill="#d8d4ca" />
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"
      fill="#c99a2e"
      style={{ transformOrigin: '12px 12px', transform: `scale(${on})` }}
    />
  </svg>
);

/** Cursor de mouse. */
export const Cursor = ({ x, y, press }: { x: number; y: number; press: number }) => (
  <svg
    width={44}
    height={44}
    viewBox="0 0 24 24"
    style={{ position: 'absolute', left: x, top: y, transform: `scale(${1 - press * 0.15})`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.25))', zIndex: 50 }}
  >
    <path d="M4 2l15 11.2-6.6.9 3.9 7.6-2.8 1.4-3.9-7.6L4 20z" fill="#111" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
  </svg>
);
