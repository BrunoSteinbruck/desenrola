/** Tamanho máximo do título de um pedido: é o que cabe numa linha da sidebar. */
export const TITLE_MAX = 48;

/** Corta no limite sem quebrar palavra; tira pontuação solta do fim. */
export function shortTitle(raw: string | null | undefined, max = TITLE_MAX): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  const base = (space > max * 0.5 ? cut.slice(0, space) : s.slice(0, max - 1)).replace(/[\s,;:.\-–—]+$/, '');
  return `${base}…`;
}
