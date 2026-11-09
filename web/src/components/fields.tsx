import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CITIES, fold, neighborhoodsOf } from '../lib/options';
import { IconCheck, IconChevron, IconSearch } from './ui';

/* Campos de formulário usados em todas as telas: celular, código, seleção simples, lista marcável e cobertura. */

// ---------- celular ----------

/** Só os dígitos do celular, sem o 55 (também quando vem do preenchimento automático). */
export const phoneDigits = (s: string) => {
  const d = s.replace(/\D/g, '');
  return (d.length > 11 && d.startsWith('55') ? d.slice(2) : d).slice(0, 11);
};
export const phoneOk = (s: string) => phoneDigits(s).length >= 10;

export function maskPhone(s: string) {
  const d = phoneDigits(s);
  if (d.length <= 2) return d ? `(${d}` : '';
  const head = `(${d.slice(0, 2)}) `;
  const rest = d.slice(2);
  if (rest.length <= 4) return head + rest;
  return rest.length <= 8 ? `${head}${rest.slice(0, 4)}-${rest.slice(4)}` : `${head}${rest.slice(0, 5)}-${rest.slice(5)}`;
}

export function PhoneInput({ id, value, onChange, autoFocus, required }: { id?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; required?: boolean }) {
  return (
    <input
      id={id}
      className="ob-input"
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      autoFocus={autoFocus}
      required={required}
      placeholder="(51) 99999-9999"
      value={value}
      onChange={(e) => onChange(maskPhone(e.target.value))}
    />
  );
}

// ---------- código de 6 números ----------

/** Seis casas, com colar e preenchimento automático. Ao completar, chama `onComplete`. */
export function CodeInput({ id, value, onChange, onComplete }: { id?: string; value: string; onChange: (v: string) => void; onComplete?: (code: string) => void }) {
  const [focused, setFocused] = useState(true);
  return (
    <div className={`code-cells${focused ? ' focused' : ''}`}>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          onChange(v);
          if (v.length === 6 && value.length !== 6) onComplete?.(v);
        }}
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} aria-hidden="true" className={`code-cell${i === Math.min(value.length, 5) ? ' current' : ''}${value[i] ? ' filled' : ''}`}>
          {value[i] ?? ''}
        </span>
      ))}
    </div>
  );
}

// ---------- lista de opções ----------

type Item = { value: string; add?: boolean };

/** Teclado e estado da lista, iguais na seleção simples e na múltipla. */
function useList(items: Item[], open: boolean, onPick: (it: Item) => void, typing: boolean) {
  // só já vem marcada a primeira opção quando a pessoa digitou algo: Enter num campo intacto não escolhe nada
  const first = typing ? 0 : -1;
  // a marca volta pro início quando a lista muda (calculado aqui, sem efeito: um Enter logo depois de digitar já vale)
  const sig = `${items.length}|${open}|${first}`;
  const [cursor, setCursor] = useState({ sig, i: first });
  const active = cursor.sig === sig ? cursor.i : first;
  const setActive = (i: number) => setCursor({ sig, i });
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const onKey = (e: KeyboardEvent, setOpen: (o: boolean) => void) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const n = items.length || 1;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Enter' && open && items[active]) {
      e.preventDefault();
      onPick(items[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  return { active, setActive, listRef, onKey };
}

function Options({ id, items, active, setActive, listRef, onPick, selected, empty }: {
  id: string;
  items: Item[];
  active: number;
  setActive: (i: number) => void;
  listRef: React.RefObject<HTMLUListElement | null>;
  onPick: (it: Item) => void;
  selected?: (v: string) => boolean;
  empty?: string;
}) {
  if (!items.length && !empty) return null;
  return (
    <ul id={id} ref={listRef} className="combo-list" role="listbox">
      {!items.length && <li className="combo-empty">{empty}</li>}
      {items.map((it, i) => (
        <li
          key={it.value + (it.add ? '+' : '')}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={`combo-opt${i === active ? ' active' : ''}`}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // não tira o foco do campo
            onPick(it);
          }}
        >
          {it.add ? (
            <span>
              Adicionar <strong>{it.value}</strong>
            </span>
          ) : (
            <span>{it.value}</span>
          )}
          {selected?.(it.value) && <IconCheck />}
        </li>
      ))}
    </ul>
  );
}

// ---------- seleção simples, com digitação livre ----------

export function ComboInput({ id, value, onChange, options, placeholder, autoFocus, autoComplete = 'off' }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const [open, setOpen] = useState(false);
  const items = useMemo<Item[]>(() => {
    const q = fold(value);
    const exact = options.some((o) => fold(o) === q);
    // com o valor já escolhido, abre a lista inteira pra poder trocar
    return (exact ? options : options.filter((o) => fold(o).includes(q))).slice(0, 80).map((v) => ({ value: v }));
  }, [value, options]);
  const pick = (it: Item) => {
    onChange(it.value);
    setOpen(false);
  };
  const typing = !!value.trim() && !options.some((o) => fold(o) === fold(value));
  const { active, setActive, listRef, onKey } = useList(items, open, pick, typing);
  const show = open && items.length > 0;
  return (
    <div className="combo">
      <input
        id={id}
        className="ob-input combo-input"
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => onKey(e, setOpen)}
      />
      <span className="combo-caret" aria-hidden="true">
        <IconChevron />
      </span>
      {show && <Options id={listId} items={items} active={active} setActive={setActive} listRef={listRef} onPick={pick} />}
    </div>
  );
}

// ---------- seleção múltipla ----------

/**
 * Caixa fechada que abre uma lista marcável: vai marcando o que quiser e a lista continua aberta.
 * `allLabel`: primeira opção, marcada quando nada específico foi escolhido (ex.: "A cidade toda").
 * `allowAdd`: dá pra incluir o que não está na lista, digitando na busca.
 */
export function MultiSelect({ id, value, onChange, options, placeholder = 'Selecionar', searchPlaceholder = 'Buscar', allLabel, allowAdd, lowercase }: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  allLabel?: string;
  allowAdd?: boolean;
  lowercase?: boolean;
}) {
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  // quem já estava marcado aparece primeiro; a ordem só muda ao abrir, nunca enquanto a pessoa marca
  const [order, setOrder] = useState<string[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const showSearch = !!allowAdd || options.length > 7;

  const has = (v: string) => value.some((x) => fold(x) === fold(v));
  const openList = () => {
    const extras = value.filter((v) => !options.some((o) => fold(o) === fold(v)));
    setOrder([...value.filter((v) => !extras.includes(v)), ...extras, ...options.filter((o) => !has(o))]);
    setQ('');
    setActive(-1);
    setOpen(true);
  };
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  type Row = { kind: 'all' | 'opt' | 'add'; value: string };
  const f = fold(q);
  const typed = q.replace(/\s+/g, ' ').trim();
  const rows: Row[] = [
    ...(allLabel && !f ? [{ kind: 'all' as const, value: allLabel }] : []),
    ...order.filter((o) => fold(o).includes(f)).map((value) => ({ kind: 'opt' as const, value })),
    ...(allowAdd && f && !order.some((o) => fold(o) === f) ? [{ kind: 'add' as const, value: lowercase ? typed.toLowerCase() : typed }] : []),
  ];

  useEffect(() => {
    if (active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const toggle = (r: Row) => {
    if (r.kind === 'all') onChange([]);
    else if (r.kind === 'add') {
      onChange([...value, r.value]);
      setOrder((o) => [r.value, ...o]);
    } else onChange(has(r.value) ? value.filter((x) => fold(x) !== fold(r.value)) : [...value, r.value]);
    if (q) {
      setQ('');
      setActive(-1);
      search.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length || 1;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Enter' || (e.key === ' ' && document.activeElement !== search.current)) {
      e.preventDefault(); // Enter aqui marca a opção, não envia o formulário
      const r = rows[active >= 0 ? active : f ? 0 : -1];
      if (r) toggle(r);
    } else if (e.key === 'Tab') close();
  };

  const summary = value.length ? (
    <>
      <span className="ms-values">{value.slice(0, 2).join(', ')}</span>
      {value.length > 2 && <span className="ms-more">+{value.length - 2}</span>}
    </>
  ) : (
    <span className={allLabel ? 'ms-values' : 'ms-placeholder'}>{allLabel ?? placeholder}</span>
  );

  return (
    <div className="combo" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button
        id={id}
        ref={trigger}
        type="button"
        className={`ms-trigger${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? close() : openList())}
      >
        {summary}
        <span className="ms-caret" aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="ms-panel">
          {showSearch && (
            <div className="ms-search">
              <IconSearch />
              <input
                ref={search}
                aria-label={searchPlaceholder}
                autoComplete="off"
                placeholder={searchPlaceholder}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(-1);
                }}
              />
            </div>
          )}
          <ul id={listId} ref={listRef} className="ms-list" role="listbox" aria-multiselectable="true" tabIndex={showSearch ? -1 : 0}>
            {rows.length === 0 && <li className="combo-empty">Nada encontrado.</li>}
            {rows.map((r, i) => {
              const on = r.kind === 'all' ? value.length === 0 : r.kind === 'opt' && has(r.value);
              return (
                <li
                  key={`${r.kind}:${r.value}`}
                  role="option"
                  aria-selected={on}
                  className={`ms-row${i === active ? ' active' : ''}${on ? ' on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(r)}
                >
                  {r.kind === 'add' ? (
                    <span className="ms-add">
                      Adicionar <strong>{r.value}</strong>
                    </span>
                  ) : (
                    <>
                      <span className="ms-check" aria-hidden="true">
                        {on && <IconCheck />}
                      </span>
                      {r.value}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- duas ou mais opções lado a lado ----------

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- onde atende ----------

/** `neighborhoods`: null = cidade toda; lista = só esses bairros. */
export type Coverage = { city: string; neighborhoods: string[] | null };
export const coverageOk = (c: Coverage) => !!c.city.trim() && (c.neighborhoods === null || c.neighborhoods.length > 0);

export function CoverageFields({ value, onChange, idPrefix }: { value: Coverage; onChange: (c: Coverage) => void; idPrefix: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-city`}>Cidade</label>
        {/* os bairros são da cidade: trocou a cidade, volta pra cidade toda */}
        <ComboInput id={`${idPrefix}-city`} value={value.city} options={CITIES} onChange={(city) => onChange({ city, neighborhoods: fold(city) === fold(value.city) ? value.neighborhoods : null })} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-hoods`}>Onde atende</label>
        <MultiSelect
          id={`${idPrefix}-hoods`}
          allLabel="A cidade toda"
          allowAdd
          searchPlaceholder="Buscar bairro"
          value={value.neighborhoods ?? []}
          options={neighborhoodsOf(value.city)}
          onChange={(v) => onChange({ ...value, neighborhoods: v.length ? v : null })}
        />
      </div>
    </>
  );
}
