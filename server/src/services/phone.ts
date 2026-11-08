// Normalização de telefones brasileiros para JID do WhatsApp.

/** Só dígitos. */
export function digits(s: string): string {
  return (s ?? '').replace(/\D+/g, '');
}

/**
 * Converte "(51) 99123-4567", "+55 51 99123-4567" etc. para E.164 sem "+": "5551991234567".
 * Retorna null se não parecer um número BR válido.
 */
export function toE164BR(raw: string): string | null {
  let d = digits(raw);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1); // 0 + operadora/DDD
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!d.startsWith('55')) return null;
  if (d.length !== 12 && d.length !== 13) return null;
  return d;
}

/** Celular BR: depois do DDD, 9 dígitos começando com 9 (ou 8 dígitos legados começando com 6-9). */
export function isMobileBR(e164: string): boolean {
  const local = e164.slice(4); // tira 55 + DDD
  if (local.length === 9) return local.startsWith('9');
  if (local.length === 8) return /^[6-9]/.test(local);
  return false;
}

/** Variações para consultar no WhatsApp (com e sem o 9º dígito). */
export function waCandidates(e164: string): string[] {
  const ddd = e164.slice(2, 4);
  const local = e164.slice(4);
  const out = new Set<string>([e164]);
  if (local.length === 9 && local.startsWith('9')) out.add(`55${ddd}${local.slice(1)}`);
  if (local.length === 8) out.add(`55${ddd}9${local}`);
  return [...out];
}

/**
 * Forma canônica de celular BR: sempre com o 9º dígito. O WhatsApp de contas antigas usa o número
 * sem o 9 ("555185907072"); aqui vira "5551985907072" pra bater com o cadastro.
 */
export function canonicalBR(raw: string): string {
  const d = digits(raw);
  if (d.length === 12 && d.startsWith('55') && /^[6-9]/.test(d.slice(4))) return `${d.slice(0, 4)}9${d.slice(4)}`;
  return d;
}

/** O outro formato do mesmo celular (com ↔ sem o 9º dígito), ou null se não houver. */
export function altWhatsAppBR(phone: string): string | null {
  const d = digits(phone);
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return `${d.slice(0, 4)}${d.slice(5)}`;
  if (d.length === 12 && d.startsWith('55') && /^[6-9]/.test(d.slice(4))) return `${d.slice(0, 4)}9${d.slice(4)}`;
  return null;
}

export function formatBR(e164: string): string {
  const ddd = e164.slice(2, 4);
  const local = e164.slice(4);
  if (local.length === 9) return `(${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
  return `(${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
}
