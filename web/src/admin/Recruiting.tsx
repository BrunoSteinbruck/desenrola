import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ComboInput, Segmented } from '../components/fields';
import { SERVICES } from '../lib/options';
import { call } from './adminApi';
import { ActionsMenu, draftOk, Drawer, errMsg, ProviderFields, type ProviderDraft } from './parts';

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

export function RecruitingTab({ onPromoted, notify, serviceOptions }: { onPromoted: () => void; notify: (m: string) => void; serviceOptions: string[] }) {
  const [data, setData] = useState<Recruiting | null>(null);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<LeadStatus | 'todos'>('todos');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<Lead | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    if (status !== 'todos') qs.set('status', status);
    call<Recruiting>('GET', `/recruiting?${qs}`).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => setError(errMsg(e)),
    );
  }, [category, status]);
  useEffect(load, [load]);

  const mark = async (l: Lead, s: LeadStatus) => {
    try {
      await call('PUT', `/leads/${l.id}`, { lead_status: s });
      load();
    } catch (e) {
      notify(errMsg(e));
    }
  };

  const copy = (l: Lead) => {
    void navigator.clipboard?.writeText(l.invite_text);
    setCopied(l.id);
    setTimeout(() => setCopied((c) => (c === l.id ? null : c)), 2000);
  };

  const services = [...new Set([...SERVICES, ...serviceOptions])];

  return (
    <main className="adm-page">
      <div className="adm-page-head">
        <h1>Recrutamento</h1>
      </div>

      {data && data.demand.length > 0 && (
        <section className="adm-section" aria-labelledby="rec-demand">
          <h2 id="rec-demand">Onde falta profissional</h2>
          <p className="adm-sub">Pedidos dos últimos 30 dias que ficaram sem ninguém. Clica pra ver os contatos do serviço.</p>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="cell-num">Pedidos</th>
                  <th>Serviço</th>
                  <th>Região</th>
                  <th className="cell-num">Cadastrados</th>
                  <th className="cell-num">Contatos</th>
                </tr>
              </thead>
              <tbody>
                {data.demand.map((d) => (
                  <tr key={`${d.category}|${d.city}`} className={`clickable${category === d.category ? ' selected' : ''}`} onClick={() => setCategory(category === d.category ? '' : d.category)}>
                    <td className="cell-num cell-strong">{d.n}</td>
                    <td data-cell="main">
                      <button type="button" className="cell-title" aria-pressed={category === d.category}>
                        {d.category}
                      </button>
                    </td>
                    <td className="cell-region">
                      {d.city}
                      {d.neighborhoods.length ? `: ${d.neighborhoods.join(', ')}` : ''}
                    </td>
                    <td className="cell-num">{d.registered}</td>
                    <td className="cell-num">{d.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="adm-section" aria-labelledby="rec-leads">
        <h2 id="rec-leads">Contatos pra convidar</h2>
        <p className="adm-sub">Quem os clientes mais tentaram chamar vem primeiro. Convida por ligação ou pelo chip de recrutamento, nunca pelo número da plataforma.</p>
        <div className="adm-toolbar">
          <Segmented
            label="Situação"
            value={status}
            onChange={setStatus}
            options={[{ value: 'todos', label: 'Todos' }, ...(Object.keys(LEAD_LABEL) as LeadStatus[]).map((s) => ({ value: s, label: LEAD_LABEL[s] }))]}
          />
          <div className="adm-filter-combo">
            <label className="sr-only" htmlFor="rec-cat">
              Filtrar por serviço
            </label>
            <ComboInput id="rec-cat" browse placeholder="Todos os serviços" value={category} options={services} onChange={setCategory} />
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="adm-table-wrap">
          {!data ? (
            <p className="adm-empty">Carregando…</p>
          ) : data.leads.length === 0 ? (
            <p className="adm-empty">Nenhum contato com esse filtro.</p>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Contato</th>
                  <th>Serviços</th>
                  <th>Região</th>
                  <th>Procura</th>
                  <th>Situação</th>
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.leads.map((l) => (
                  <tr key={l.id}>
                    <td data-cell="main">
                      <div className="cell-title static">{l.name}</div>
                      <div className="cell-sub">
                        {l.phone_display ?? 'sem telefone'}
                        {l.phone && !l.mobile ? ' (fixo)' : ''}
                        {l.rating != null && ` · ${l.rating.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} no Google${l.reviews ? ` (${l.reviews})` : ''}`}
                      </div>
                      {l.lead_note && <div className="cell-sub">{l.lead_note}</div>}
                    </td>
                    <td>{l.categories.join(', ')}</td>
                    <td className="cell-region">{[l.cities.join(', '), l.neighborhoods.join(', ')].filter(Boolean).join(': ')}</td>
                    <td>{l.demand > 0 ? `${l.demand} cliente${l.demand === 1 ? '' : 's'}` : <span className="cell-none">-</span>}</td>
                    <td>
                      <span className={`status-dot lead-${l.lead_status}`}>{LEAD_LABEL[l.lead_status]}</span>
                    </td>
                    <td className="cell-actions">
                      <button type="button" className="abtn small" title={l.invite_text} onClick={() => copy(l)}>
                        {copied === l.id ? 'Copiado' : 'Copiar convite'}
                      </button>
                      <button type="button" className="abtn small" onClick={() => setPromoting(l)}>
                        Cadastrar
                      </button>
                      <ActionsMenu
                        label={`Mais ações de ${l.name}`}
                        items={[
                          ...(l.lead_status !== 'convidado' ? [{ label: 'Marcar como convidado', onClick: () => void mark(l, 'convidado') }] : []),
                          ...(l.lead_status !== 'sem_whatsapp' ? [{ label: 'Marcar sem WhatsApp', onClick: () => void mark(l, 'sem_whatsapp') }] : []),
                          ...(l.lead_status !== 'recusou' ? [{ label: 'Marcar que recusou', danger: true, onClick: () => void mark(l, 'recusou') }] : []),
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {promoting && (
        <PromoteDrawer
          lead={promoting}
          serviceOptions={services}
          onClose={() => setPromoting(null)}
          onDone={() => {
            notify(`Pedido de confirmação enviado pra ${promoting.name}.`);
            setPromoting(null);
            load();
            onPromoted();
          }}
        />
      )}
    </main>
  );
}

function PromoteDrawer({ lead, serviceOptions, onClose, onDone }: { lead: Lead; serviceOptions: string[]; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState<ProviderDraft>({
    name: lead.name,
    phone: '',
    services: lead.categories,
    coverage: { city: lead.cities[0] ?? 'Porto Alegre', neighborhoods: lead.neighborhoods.length ? lead.neighborhoods : null },
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draftOk(d, false) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/leads/${lead.id}/promote`, { name: d.name, categories: d.services, city: d.coverage.city, neighborhoods: d.coverage.neighborhoods ?? [] });
      onDone();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Cadastrar contato"
      subtitle="Só recebe pedidos depois de confirmar no WhatsApp."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && <p className="error-text">{error}</p>}
          <div className="drawer-actions">
            <button type="button" className="abtn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="abtn primary" disabled={busy || !draftOk(d, false)}>
              {busy ? 'Enviando…' : 'Cadastrar e pedir confirmação'}
            </button>
          </div>
        </>
      }
    >
      <ProviderFields value={d} onChange={setD} phone={lead.phone_display ?? 'sem telefone'} serviceOptions={serviceOptions} showNotes={false} />
    </Drawer>
  );
}
