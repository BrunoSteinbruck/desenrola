import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconUp = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const IconMenu = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const IconGear = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
const icon = (d: string, size = 16) => () => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const IconPhone = icon('M8.5 3h7A1.5 1.5 0 0 1 17 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19.5v-15A1.5 1.5 0 0 1 8.5 3zM11 17.5h2');
export const IconX = icon('M6 6l12 12M18 6L6 18');
export const IconCheck = icon('M5 12.5l4.5 4.5L19 7.5');
export const IconChevron = icon('M7 10l5 5 5-5');
export const IconSearch = icon('M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4');
export const IconMore = icon('M5 12h.01M12 12h.01M19 12h.01', 18);
export const IconBack = icon('M15 6l-6 6 6 6');
export const IconSend = icon('M12 19V5M5 12l7-7 7 7');
export const IconStar = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z" />
  </svg>
);

/** Caixa de texto que cresce, Enter envia, Shift+Enter quebra linha. */
export function Composer({
  onSend,
  placeholder,
  big,
  disabled,
  autoFocus,
  id,
  label,
}: {
  onSend: (text: string) => void | Promise<void>;
  placeholder: string;
  big?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  id: string;
  label: string;
}) {
  const [text, setText] = useState('');
  // caixa grande da home: pulsa em ondas suaves até a pessoa começar a digitar; depois para de vez
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    await onSend(t);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className={`composer glass${big ? ` big ${touched ? 'engaged' : 'waiting'}` : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {big && (
        <span className="fx" aria-hidden="true">
          <span className="glow" />
          <span className="beam" />
          <span className="ring" />
        </span>
      )}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={big ? 2 : 1}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value) setTouched(true);
        }}
        onKeyDown={onKey}
      />
      <button type="submit" className="send" aria-label="Enviar" disabled={disabled || !text.trim()}>
        <IconUp />
      </button>
    </form>
  );
}
