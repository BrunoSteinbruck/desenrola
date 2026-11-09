import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CoverageFields, coverageOk, MultiSelect, PhoneInput, phoneOk, type Coverage } from '../components/fields';
import { IconMore, IconX } from '../components/ui';
import { SERVICES } from '../lib/options';

/* Peças compartilhadas do admin: painel lateral, confirmação, menu de ações e o formulário de profissional. */

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Deu algum problema. Tenta de novo.');

/** Fecha com Esc e devolve o foco pra quem abriu. */
function useModal(onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function Drawer({ title, subtitle, onClose, children, footer, onSubmit }: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (e: FormEvent) => void;
}) {
  useModal(onClose);
  const Tag = onSubmit ? 'form' : 'div';
  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Tag className="drawer" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}>
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <button type="button" className="adm-icon" aria-label="Fechar" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </Tag>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger, onConfirm, onClose }: {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useModal(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="confirm-actions">
          <button type="button" className="abtn" autoFocus onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={`abtn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean };

/** Botão de "mais ações". A lista fica fixa na tela, pra não ser cortada pela tabela. */
export function ActionsMenu({ label, items, disabled }: { label: string; items: MenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = list.current?.offsetHeight ?? 0;
    const below = r.bottom + 4 + h <= window.innerHeight;
    setPos({ top: below ? r.bottom + 4 : r.top - h - 4, right: window.innerWidth - r.right });
    (list.current?.querySelector('button') as HTMLButtonElement | null)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        btn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const bs = [...(list.current?.querySelectorAll('button') ?? [])];
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="adm-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <IconMore />
      </button>
      {open && (
        <div ref={list} className="menu" role="menu" style={pos} onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : ''}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export type ProviderDraft = { name: string; phone: string; services: string[]; coverage: Coverage; notes: string };

export const draftOk = (d: ProviderDraft, needPhone: boolean) =>
  !!d.name.trim() && d.services.length > 0 && coverageOk(d.coverage) && (!needPhone || phoneOk(d.phone));

/** Os campos do profissional: iguais em adicionar, editar e cadastrar um contato. */
export function ProviderFields({ value, onChange, phone, serviceOptions, showNotes = true }: {
  value: ProviderDraft;
  onChange: (d: ProviderDraft) => void;
  /** editable = digita; texto = mostra sem deixar mudar */
  phone: 'editable' | string;
  serviceOptions: string[];
  showNotes?: boolean;
}) {
  const options = [...new Set([...SERVICES, ...serviceOptions])];
  return (
    <div className="form-stack">
      <label className="field" htmlFor="pf-name">
        Nome
        <input id="pf-name" className="ob-input" required autoFocus autoComplete="off" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </label>
      {phone === 'editable' ? (
        <label className="field" htmlFor="pf-phone">
          Celular com WhatsApp
          <PhoneInput id="pf-phone" required value={value.phone} onChange={(v) => onChange({ ...value, phone: v })} />
        </label>
      ) : (
        <div className="field">
          <span>Celular com WhatsApp</span>
          <span className="field-static">{phone}</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="pf-services">Serviços</label>
        <MultiSelect id="pf-services" allowAdd lowercase value={value.services} options={options} placeholder="Selecionar serviços" searchPlaceholder="Buscar serviço" onChange={(services) => onChange({ ...value, services })} />
      </div>
      <CoverageFields idPrefix="pf" value={value.coverage} onChange={(coverage) => onChange({ ...value, coverage })} />
      {showNotes && (
        <label className="field" htmlFor="pf-notes">
          <span>
            Observações <em className="optional">opcional, só a equipe vê</em>
          </span>
          <textarea id="pf-notes" className="ob-input adm-textarea" rows={3} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} />
        </label>
      )}
    </div>
  );
}
