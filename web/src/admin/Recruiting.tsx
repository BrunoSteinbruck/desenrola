import { useCallback, useEffect, useState, type FormEvent } from 'react';

/* Aba Recrutamento (F4): onde falta profissional e quem convidar primeiro. */

type LeadStatus = 'novo' | 'convidado' | 'recusou' | 'sem_whatsapp';
type Lead = {
  id: number;
  name: string;
  phone: string | null;
  phone_display: string | null;
  mobile: boolean;
  rating: number | null;
  reviews: number | null;
  address: string | null;
  website: string | null;
  categories: string[];
  cities: string[];
  neighborhoods: string[];
  lead_status: LeadStatus;
  lead_note: string | null;
  demand: number;
  last_demand_at: string | null;
  times_found: number;
  invite_text: string;
};
type Demand = { category: string; city: string; neighborhoods: string[]; n: number; last_at: string; registered: number; leads: number };
type Recruiting = { demand: Demand[]; leads: Lead[]; counts: { leads: number; novo: number; convidado: number; with_demand: number } };

const LEAD_LABEL: Record<LeadStatus, string> = { novo: 'Novo', convidado: 'Convidado', recusou: 'Recusou', sem_whatsapp: 'Sem WhatsApp' };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `Erro ${res.status}`);
  return data as T;
}

export function RecruitingTab({ onPromoted }: { onPromoted: () => void }) {
  const [data, setData] = useState<Recruiting | null>(null);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<Lead | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    if (status) qs.set('status', status);
    call<Recruiting>('GET', `/recruiting?${qs}`).then(setData, (e) => setError(String(e.message ?? e)));
  }, [category, status]);
  useEffect(load, [load]);

  const mark = async (l: Lead, s: LeadStatus) => {
    try {
      await call('PUT', `/leads/${l.id}`, { lead_status: s });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="rec-layout">
      <section className="adm-panel glass" aria-labelledby="rec-demand">
        <h2 id="rec-demand" >Onde falta profissional</h2>
        <p className="adm-hint">Pedidos dos últimos 30 dias que terminaram sem ninguém cadastrado.</p>
        {!data ? (
          <p className="adm-empty">Carregando…</p>
        ) : data.demand.length === 0 ? (
          <p className="adm-empty">Nenhum pedido ficou sem profissional.</p>
        ) : (
          <ul className="rec-demand">
            {data.demand.map((d) => (
              <li key={`${d.category}|${d.city}`}>
                <button type="button" className={`rec-demand-item${category === d.category ? ' active' : ''}`} onClick={() => setCategory(category === d.category ? '' : d.category)}>
                  <span className="rec-n">{d.n}</span>
                  <span className="rec-what">
                    <strong>{d.category}</strong>
                    <small>
                      {d.city}
                      {d.neighborhoods.length ? ` · ${d.neighborhoods.join(', ')}` : ''}
                    </small>
                  </span>
                  <span className="rec-have">
                    {d.registered} cadastrado{d.registered === 1 ? '' : 's'} · {d.leads} contato{d.leads === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="adm-panel glass" aria-labelledby="rec-leads">
        <div className="adm-panel-head">
          <h2 id="rec-leads" >
            Contatos pra convidar <span className="adm-count">{data?.counts.leads ?? ''}</span>
          </h2>
          <div className="rec-filters">
            <label className="sr-only" htmlFor="rec-cat">
              Profissão
            </label>
            <input id="rec-cat" className="ob-input" placeholder="Profissão" value={category} onChange={(e) => setCategory(e.target.value)} />
            <label className="sr-only" htmlFor="rec-status">
              Situação
            </label>
            <select id="rec-status" className="ob-input" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')}>
              <option value="">Todos</option>
              {(Object.keys(LEAD_LABEL) as LeadStatus[]).map((s) => (
                <option key={s} value={s}>
                  {LEAD_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="adm-hint">
          Quem os clientes mais tentaram chamar vem primeiro. Convida à mão (ligação ou o chip de recrutamento, nunca o número da plataforma). Se topar, "Cadastrar".
        </p>
        {error && <p className="error-text">{error}</p>}
        {!data ? (
          <p className="adm-empty">Carregando…</p>
        ) : data.leads.length === 0 ? (
          <p className="adm-empty">Nenhum contato com esse filtro.</p>
        ) : (
          <ul className="adm-plist">
            {data.leads.map((l) => (
              <li key={l.id} className="adm-prow">
                <div className="adm-prow-main">
                  <div className="adm-prow-top adm-pname">
                    {l.name} <span className={`adm-pill st-lead-${l.lead_status}`}>{LEAD_LABEL[l.lead_status]}</span>
                    {l.demand > 0 && <span className="adm-pill st-ativo">{l.demand} cliente{l.demand === 1 ? '' : 's'} quis chamar</span>}
                  </div>
                  <div className="adm-pmeta">
                    <span>{l.phone_display ?? 'sem telefone'}{l.phone && !l.mobile ? ' (fixo)' : ''}</span>
                    <span>{l.categories.join(', ')}</span>
                    <span>{[l.cities.join(', '), l.neighborhoods.join(', ')].filter(Boolean).join(' · ')}</span>
                    {l.rating != null && (
                      <span>
                        {l.rating.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} no Google{l.reviews ? ` (${l.reviews})` : ''}
                      </span>
                    )}
                  </div>
                  {l.lead_note && <div className="adm-notes">{l.lead_note}</div>}
                </div>
                <div className="adm-prow-actions">
                  <button
                    type="button"
                    className="btn adm-small-btn"
                    onClick={() => {
                      void navigator.clipboard?.writeText(l.invite_text);
                      setCopied(l.id);
                      setTimeout(() => setCopied((c) => (c === l.id ? null : c)), 2000);
                    }}
                    title={l.invite_text}
                  >
                    {copied === l.id ? 'Copiado' : 'Copiar convite'}
                  </button>
                  {l.lead_status === 'novo' && (
                    <button type="button" className="btn adm-small-btn" onClick={() => void mark(l, 'convidado')}>
                      Marquei convidado
                    </button>
                  )}
                  <button type="button" className="btn dark adm-small-btn" onClick={() => setPromoting(l)}>
                    Cadastrar
                  </button>
                  {l.lead_status !== 'recusou' && (
                    <button type="button" className="btn ghost adm-small-btn" onClick={() => void mark(l, 'recusou')}>
                      Recusou
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {promoting && (
        <PromoteDialog
          lead={promoting}
          onClose={() => setPromoting(null)}
          onDone={() => {
            setPromoting(null);
            load();
            onPromoted();
          }}
        />
      )}
    </div>
  );
}

function PromoteDialog({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(lead.name);
  const [categories, setCategories] = useState(lead.categories.join(', '));
  const [city, setCity] = useState(lead.cities[0] ?? 'Porto Alegre');
  const [hoods, setHoods] = useState(lead.neighborhoods.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/leads/${lead.id}/promote`, { name, categories, city, neighborhoods: hoods });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog glass" role="dialog" aria-modal="true" aria-label={`Cadastrar ${lead.name}`} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Cadastrar {lead.name}</h2>
        <p className="note">Ele recebe no WhatsApp o pedido de confirmação. Só depois do "Sim" passa a receber pedidos.</p>
        <label className="field">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Categorias (separa por vírgula)
          <input value={categories} onChange={(e) => setCategories(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            Cidade
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="field">
            Bairros (vazio = cidade toda)
            <input value={hoods} onChange={(e) => setHoods(e.target.value)} />
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn dark" disabled={busy || !name.trim() || !categories.trim() || !city.trim()}>
            {busy ? 'Enviando…' : 'Cadastrar e pedir confirmação'}
          </button>
        </div>
      </form>
    </div>
  );
}
