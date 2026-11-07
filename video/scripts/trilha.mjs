// Gera a trilha do vídeo (música + efeitos) só com síntese, sem sample nem download.
// Clima: apresentação de produto/tecnologia — sintetizadores, arpejo, graves, subidas.
// Saída: public/trilha.wav (48 kHz, estéreo, 47,5 s). Rodar: node scripts/trilha.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 48000;
const FPS = 30;
const DUR = 1425 / FPS;
const N = Math.ceil(DUR * SR);
const music = { L: new Float32Array(N), R: new Float32Array(N) };
const sfx = { L: new Float32Array(N), R: new Float32Array(N) };

const BPM = 120;
const BEAT = 60 / BPM; // 0,5 s = 15 frames
const S16 = BEAT / 4;
const fr = (f) => f / FPS;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function add(bus, t0, len, fn, gain = 1, pan = 0) {
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j < 0 || j >= N) continue;
    const v = fn(i / SR, len);
    bus.L[j] += v * gl;
    bus.R[j] += v * gr;
  }
}
const env = (t, a, len, rel = 0.08) => Math.min(1, t / a) * clamp((len - t) / rel, 0, 1);
// filtro passa-baixa ressonante (state variable)
const svf = () => {
  let lp = 0, bp = 0;
  return (x, fc, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * clamp(fc, 20, 7000)) / SR);
    const hp = x - lp - q * bp;
    bp += f * hp;
    lp += f * bp;
    return lp;
  };
};
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));

// ---------- instrumentos ----------
// cama de sintetizador: serras desafinadas, filtro abrindo devagar
const pad = (notes, t0, len, gain, fcFrom = 600, fcTo = 1400) =>
  notes.forEach((m, k) =>
    [-0.12, 0, 0.12].forEach((det, d) => {
      const filt = svf();
      const f = hz(m + det);
      add(music, t0, len, (t, l) => filt(saw(f * t + d * 0.3), fcFrom + (fcTo - fcFrom) * (t / l), 0.9) * env(t, 0.5, l, 0.6), gain / notes.length / 2, (d - 1) * 0.7 * (k % 2 ? 1 : -1));
    }),
  );
// arpejo "pluck": serra com filtro que fecha rápido e eco
const pluck = (m, t0, gain, bright = 1, pan = 0) => {
  const filt = svf();
  const f = hz(m);
  add(music, t0, 0.45, (t) => filt(saw(f * t) * 0.7 + saw(f * 1.005 * t) * 0.5, 300 + 3200 * bright * Math.exp(-t * 14), 0.35) * Math.exp(-t * 6) * Math.min(1, t / 0.002), gain, pan);
};
const sub = (m, t0, len, gain = 0.32) =>
  add(music, t0, len, (t, l) => Math.sin(2 * Math.PI * hz(m) * t) * env(t, 0.008, l, 0.05), gain);
const kick = (t0, gain = 0.4) =>
  add(music, t0, 0.4, (t) => Math.sin(2 * Math.PI * (42 * t + (130 / 30) * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 8), gain);
const tick = (t0, gain = 0.03, pan = 0.3) => {
  const filt = svf();
  add(music, t0, 0.04, (t) => (rnd() - filt(rnd(), 6000)) * Math.exp(-t * 120), gain, pan);
};
// batida eletrônica seca (no lugar do "clap")
const snap = (t0, gain = 0.08) => {
  const filt = svf();
  add(music, t0, 0.18, (t) => filt(rnd(), 2500, 1.2) * Math.exp(-t * 28) + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 40) * 0.5, gain, -0.1);
};

// ---------- efeitos ----------
const riser = (t0, len, gain = 0.12) => {
  const filt = svf();
  add(sfx, t0, len, (t, l) => {
    const x = t / l;
    return (filt(rnd(), 200 + 5000 * x * x, 0.4) + 0.3 * Math.sin(2 * Math.PI * (200 * t + 300 * t * x))) * x * x;
  }, gain);
};
const impact = (t0, gain = 0.5) => {
  const filt = svf();
  add(sfx, t0, 2.2, (t) => Math.sin(2 * Math.PI * (34 * t + (60 / 5) * (1 - Math.exp(-t * 5)))) * Math.exp(-t * 2) + filt(rnd(), 900 * Math.exp(-t * 3) + 100) * Math.exp(-t * 4) * 0.6, gain);
};
const whoosh = (t0, len = 0.5, gain = 0.1) => {
  const filt = svf();
  add(sfx, t0, len, (t, l) => {
    const x = t / l;
    return filt(rnd(), 300 + 2500 * Math.sin(Math.PI * x), 0.5) * Math.sin(Math.PI * x) ** 2;
  }, gain * 2);
};
const blip = (t0, m = 84, gain = 0.18, pan = 0) =>
  add(sfx, t0, 0.14, (t) => Math.sin(2 * Math.PI * hz(m) * (1 + 0.5 * Math.exp(-t * 60)) * t) * Math.exp(-t * 30), gain, pan);
const click = (t0, gain = 0.3) =>
  add(sfx, t0, 0.05, (t) => (Math.sin(2 * Math.PI * 1800 * t) * 0.6 + rnd() * 0.4) * Math.exp(-t * 120), gain);
const bell = (t0, m, gain, pan = 0, decay = 3.5) =>
  add(sfx, t0, 1.5, (t) => {
    const f = hz(m);
    return (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 9) + 0.2 * Math.sin(2 * Math.PI * f * 4 * t) * Math.exp(-t * 12)) * Math.exp(-t * decay) * Math.min(1, t / 0.002);
  }, gain, pan);
const chime = (t0, notes, gain = 0.1, step = 0.07) => notes.forEach((m, i) => bell(t0 + i * step, m, gain, (i - notes.length / 2) * 0.2));
// notificação de mensagem: dois toques limpos, curtos e claros
const notifyIn = (t0) => {
  bell(t0, 88, 0.2, 0.15, 7); // mi
  bell(t0 + 0.11, 93, 0.22, 0.15, 5); // lá
};
// mensagem enviada: um toque só, mais baixo e grave
const notifyOut = (t0) => bell(t0, 84, 0.12, -0.15, 9);

// ---------- música ----------
// Progressão em ré menor, com cor "tech": Dm(add9) – Bbmaj7 – Gm9 – Asus4
const prog = [
  { root: 38, chord: [62, 65, 69, 76], arp: [74, 77, 81, 76, 69, 77, 74, 81] },
  { root: 34, chord: [62, 65, 69, 70], arp: [70, 74, 77, 81, 74, 77, 70, 81] },
  { root: 31, chord: [62, 65, 69, 70], arp: [67, 70, 74, 77, 81, 74, 70, 77] },
  { root: 33, chord: [62, 64, 69, 71], arp: [69, 74, 76, 81, 76, 74, 71, 76] },
];
const BAR = BEAT * 4;
const introEnd = fr(165);
const finalAt = fr(1290);

// Parte 1 (0–5,5 s): o caos. Pulso grave tenso e ticks, sem acorde resolvido.
for (let s = 0; s * S16 < introEnd - 0.01; s++) {
  const t = s * S16;
  const x = t / introEnd;
  if (s % 4 === 0) sub(26, t, BEAT * 0.4, 0.22 + 0.1 * x);
  tick(t, (s % 4 === 0 ? 0.04 : 0.018) * (0.6 + x), s % 2 ? 0.35 : -0.35);
  if (s % 2 === 0) pluck(s % 8 < 4 ? 62 : 63, t, 0.035 + 0.04 * x, 0.3 + 0.5 * x, s % 4 ? 0.4 : -0.4);
}
pad([50, 57, 63], 0, introEnd, 0.18, 250, 900); // dissonância contida
riser(introEnd - 2.2, 2.2, 0.14);

// Parte 2: a solução. Pad + arpejo de semicolcheias + grave pulsando; a energia sobe até o "Fechado".
let bar = 0;
for (let t = introEnd; t < finalAt - 0.01; t += BAR, bar++) {
  const c = prog[Math.floor(bar / 2) % 4];
  const energy = clamp((t - introEnd) / (fr(1106) - introEnd), 0, 1); // 0 no logo, 1 no "Fechado"
  const drums = bar >= 2;
  pad(c.chord, t, BAR + 0.4, 0.2, 500 + 400 * energy, 1100 + 1400 * energy);
  for (let s = 0; s < 16; s++) {
    const ts = t + s * S16;
    // arpejo: brilho abre com a energia, alterna lados
    pluck(c.arp[s % 8], ts, 0.07, 0.35 + 0.65 * energy, s % 2 ? 0.45 : -0.45);
    if (drums) {
      tick(ts, s % 4 === 2 ? 0.05 : 0.018, s % 2 ? 0.3 : -0.3);
      // grave em colcheias, levando a "bombeada" junto com o bumbo
      if (s % 2 === 0) sub(c.root + (s % 8 === 6 ? 12 : 0), ts, S16 * 1.7, 0.26);
    }
  }
  if (drums) {
    for (let b = 0; b < 4; b++) kick(t + b * BEAT, 0.36 + 0.06 * energy);
    if (energy > 0.35) [1, 3].forEach((b) => snap(t + b * BEAT, 0.06 + 0.04 * energy));
  }
}
// final: acorde aberto em ré menor com nona, sumindo
pad([38, 50, 57, 62, 65, 69, 76], finalAt, DUR - finalAt, 0.3, 1600, 500);
sub(26, finalAt, 3.5, 0.3);
impact(finalAt, 0.4);
chime(fr(1328), [74, 81, 86, 88], 0.07, 0.11);

// ---------- efeitos sincronizados ----------
[18, 28, 38, 46, 54, 61, 67, 72].forEach((f, i) => notifyIn(fr(f) - (i % 2) * 0.02)); // o caos: um monte de notificação
impact(fr(100), 0.3); // "uma tarde inteira perdida"
impact(fr(165), 0.55); // logo
chime(fr(180), [74, 81, 86], 0.05, 0.08); // brilho no vidro
[255, 405, 540, 720, 1020, 1185].forEach((f) => whoosh(fr(f) - 0.25, 0.5, 0.08));
riser(fr(1290) - 1.6, 1.6, 0.1);
// digitando a pergunta
for (let f = 255 + 22; f < 255 + 110; f += 3) click(fr(f), 0.035 + 0.02 * Math.abs(rnd()));
click(fr(255 + 125), 0.3); // enviar
blip(fr(405 + 58), 88, 0.12); // resposta do diagnóstico
blip(fr(405 + 105), 93, 0.1); // botão aparece
for (let i = 0; i < 5; i++) {
  blip(fr(540 + 14 + i * 12), 81 + [0, 2, 3, 5, 7][i], 0.11, 0.3);
}
[760, 802, 842, 978].forEach((f) => notifyOut(fr(f)));
[902, 936].forEach((f) => notifyIn(fr(f)));
riser(fr(1020 + 79) - 1.2, 1.2, 0.08);
click(fr(1020 + 76), 0.35); // Aprovar
impact(fr(1020 + 86), 0.25);
chime(fr(1020 + 86), [74, 78, 81, 86], 0.11, 0.06); // Fechado (ré maior: resolveu)
[0, 1, 2, 3, 4].forEach((i) => bell(fr(1185 + 14 + i * 6), [74, 76, 78, 81, 86][i], 0.1));

// ---------- mixagem ----------
// eco estéreo pontuado na música
const dl = Math.floor(BEAT * 0.75 * SR);
for (let i = dl; i < N; i++) {
  music.L[i] += music.R[i - dl] * 0.22;
  music.R[i] += music.L[i - dl] * 0.22;
}
// música abaixa quando tem efeito (notificação aparece clara)
const L = new Float32Array(N);
const R = new Float32Array(N);
let envS = 0;
for (let i = 0; i < N; i++) {
  const s = Math.abs(sfx.L[i]) + Math.abs(sfx.R[i]);
  envS = Math.max(s, envS * 0.9996);
  const duck = 1 - Math.min(0.4, envS * 0.8);
  L[i] = music.L[i] * duck + sfx.L[i];
  R[i] = music.R[i] * duck + sfx.R[i];
}
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const g = Math.min(1, t / 0.05) * Math.min(1, (DUR - t) / 3);
  L[i] *= g;
  R[i] *= g;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.62 / peak;
const soft = (x) => Math.tanh(x * 1.3) / Math.tanh(1.3);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(soft(L[i] * norm) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(soft(R[i] * norm) * 32767), 46 + i * 4);
}
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/trilha.wav', import.meta.url), buf);
console.log(`trilha.wav: ${DUR.toFixed(1)} s, pico antes de normalizar ${peak.toFixed(2)}`);
