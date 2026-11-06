const TZ = 'America/Sao_Paulo';

export function nowBR(): string {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function hhmmBR(d = new Date()): string {
  return d.toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
export function hourBR(d = new Date()): number {
  return Number(d.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
}
export function formatDateBR(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/** "2026-11-10" ou "2026-11-10T14:30" (horário de Brasília) -> ISO UTC. null se inválido. */
export function parseLocalDate(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] ?? '12:00'}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function reais(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
