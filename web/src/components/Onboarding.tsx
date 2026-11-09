import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { CITIES } from '../lib/options';
import { ComboInput, NeighborhoodInput } from './fields';

/** Primeira vez: nome e lugar numa tela só. Sem gastar crédito da API. */
export function Onboarding({ initial, onDone }: { initial: Record<string, string>; onDone: () => void }) {
  const [name, setName] = useState(initial.user_name ?? '');
  const [city, setCity] = useState(initial.user_city || 'Porto Alegre');
  const [hood, setHood] = useState(initial.user_neighborhood ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  // o lugar que o mapa mostrou (nome corrigido): é isso que salva, não o texto digitado
  const [place, setPlace] = useState<{ city: string; neighborhood: string } | null>(null);

  const ready = !!name.trim() && !!city.trim() && !!hood.trim() && mapReady;

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.putSettings({
        user_name: name.trim(),
        user_city: (place?.city ?? city).trim(),
        user_neighborhood: (place?.neighborhood ?? hood).trim(),
        onboarding_done: true,
      });
      onDone();
    } catch {
      setError('Não consegui salvar agora. Tenta de novo.');
      setBusy(false);
    }
  };

  return (
    <section className="home">
      <form
        className="ob-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void finish();
        }}
      >
        <h1>Antes de começar</h1>
        <p>Preciso disso pra achar profissionais perto de ti.</p>
        <label className="field" htmlFor="ob-name">
          Teu nome
          <input id="ob-name" className="ob-input" value={name} autoFocus autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
          <span className="field-help">O profissional só recebe teu primeiro nome e teu celular depois que tu aprovar um orçamento.</span>
        </label>
        <div className="field-row">
          <div className="field">
            <label htmlFor="ob-city">Cidade</label>
            <ComboInput id="ob-city" value={city} options={CITIES} autoComplete="address-level2" onChange={setCity} />
          </div>
          <div className="field">
            <label htmlFor="ob-hood">Bairro</label>
            <NeighborhoodInput id="ob-hood" city={city} value={hood} onChange={setHood} />
          </div>
        </div>
        <MiniMap city={city} hood={hood} onReady={setMapReady} onPlace={setPlace} />
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn dark ob-submit" disabled={!ready || busy}>
          {busy ? 'Salvando…' : 'Continuar'}
        </button>
      </form>
    </section>
  );
}

/** Cidade e bairro, mapa e confirmação, dentro da conversa: aparece quando ainda não sei onde a pessoa está. */
export function PlaceStep({
  initialCity = '',
  initialHood = '',
  busy,
  onConfirm,
}: {
  initialCity?: string;
  initialHood?: string;
  busy: boolean;
  onConfirm: (city: string, neighborhood: string) => void;
}) {
  const [city, setCity] = useState(initialCity);
  const [hood, setHood] = useState(initialHood);
  const [mapReady, setMapReady] = useState(false);
  const [place, setPlace] = useState<{ city: string; neighborhood: string } | null>(null);
  const ready = !!city.trim() && !!hood.trim() && mapReady;
  // o mapa empurra o botão pra fora da tela: rola até o fim do formulário quando ele aparece e quando libera
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (place || ready) formRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [place, ready]);
  return (
    <form
      ref={formRef}
      className="ob-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onConfirm((place?.city ?? city).trim(), (place?.neighborhood ?? hood).trim());
      }}
    >
      <div className="field-row">
        <div className="field">
          <label htmlFor="place-city">Cidade</label>
          <ComboInput id="place-city" value={city} options={CITIES} autoComplete="address-level2" onChange={setCity} />
        </div>
        <div className="field">
          <label htmlFor="place-hood">Bairro</label>
          <NeighborhoodInput id="place-hood" city={city} value={hood} onChange={setHood} />
        </div>
      </div>
      <MiniMap city={city} hood={hood} onReady={setMapReady} onPlace={setPlace} />
      <button type="submit" className="btn dark ob-submit" disabled={!ready || busy}>
        {busy ? 'Procurando…' : 'É aqui'}
      </button>
    </form>
  );
}

/**
 * Mapinha do Google (embed sem chave). Aparece logo que bairro e cidade param de mudar;
 * `onReady(true)` só depois que o mapa carregou (ou não deu pra carregar), pra o "É aqui" fazer sentido.
 */
export function MiniMap({
  city,
  hood,
  onReady,
  onPlace,
}: {
  city: string;
  hood: string;
  onReady: (ok: boolean) => void;
  onPlace: (p: { city: string; neighborhood: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [resolved, setResolved] = useState<{ city: string; neighborhood: string; found: boolean } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const readyTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const loadedQuery = useRef('');
  const clearReady = () => {
    readyTimers.current.forEach(clearTimeout);
    readyTimers.current = [];
  };

  useEffect(() => {
    clearTimeout(timer.current);
    clearReady();
    onReady(false);
    onPlace(null);
    const c = city.trim();
    const h = hood.trim();
    if (c.length < 2 || h.length < 2) {
      setQuery('');
      setResolved(null);
      return;
    }
    let stale = false;
    timer.current = setTimeout(async () => {
      // corrige o nome ("Cidade b" -> "Cidade Baixa") antes de mostrar o mapa
      setResolving(true);
      const p = await api.normalizePlace(c, h).catch(() => ({ city: c, neighborhood: h, found: false }));
      if (stale) return;
      setResolving(false);
      setResolved(p);
      onPlace({ city: p.city, neighborhood: p.neighborhood });
      const q = `${p.neighborhood}, ${p.city}`;
      // mesmo lugar do mapa que já está na tela: não recarrega, então libera de novo aqui
      if (q === loadedQuery.current) readyTimers.current.push(setTimeout(() => onReady(true), 300));
      setQuery(q);
    }, 500);
    return () => {
      stale = true;
      clearTimeout(timer.current);
    };
  }, [city, hood, onReady, onPlace]);

  // novo endereço → recarrega; se em 10s não carregar, libera o botão mesmo assim
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    loadedQuery.current = ''; // um mapa novo vai carregar: ainda não tem nada confirmado na tela
    if (!query) return;
    const t = setTimeout(() => {
      setFailed(true);
      onReady(true);
    }, 10000);
    return () => {
      clearTimeout(t);
      clearReady();
    };
  }, [query, onReady]);

  if (!query)
    return <p className="ob-map-hint">{resolving ? 'Procurando o bairro…' : 'O mapa aparece aqui quando tu escolher o bairro.'}</p>;
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=14&hl=pt-BR&output=embed`;
  const link = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  return (
    <div className="ob-map">
      <div className="ob-map-frame">
        <iframe
          key={src}
          title={`Mapa de ${query}`}
          src={src}
          referrerPolicy="no-referrer-when-downgrade"
          onLoad={() => {
            // o iframe dispara load e o desenho do mapa vem logo depois
            clearReady();
            readyTimers.current.push(
              setTimeout(() => {
                setLoaded(true);
                loadedQuery.current = query;
                // o "É aqui" só libera depois de o mapa ficar 1s na tela
                readyTimers.current.push(setTimeout(() => onReady(true), 1000));
              }, 600),
            );
          }}
        />
        {!loaded && !failed && <div className="ob-map-loading">Carregando mapa…</div>}
      </div>
      {failed && !loaded ? (
        <p>
          O mapa não carregou aqui.{' '}
          <a href={link} target="_blank" rel="noreferrer">
            Abrir no Google Maps
          </a>
        </p>
      ) : resolved && !resolved.found ? (
        <p>Não achei esse bairro com certeza. Confere no mapa se é o lugar certo.</p>
      ) : (
        <p>
          <strong className="ob-place">
            {resolved?.neighborhood}, {resolved?.city}
          </strong>{' '}
          · confere se o mapa mostra o lugar certo.
        </p>
      )}
    </div>
  );
}
