import { createContext, useContext, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, ExternalLink, FileText, Grid2X2, Layers3, LoaderCircle, Menu, Plus, Search, ShieldCheck, Users, Wallet, X, Clock3, RefreshCw, Link2, AlertCircle, CheckCircle2, LogOut, Upload } from 'lucide-react';
import { NETWORK, type Award, type AwardDetail, type NetworkState, type Overview, type TransactionPlan, type Treasury, type WalletState } from '../shared/types';
import { formatAmount, parseAmount, shortAddress, UNIT, vestedRemaining } from '../shared/money';
import { accounts, login, normalize, request, signTransaction, syncFinalizedReceipts, walletProviders, providerName, type NativeAccount, type NativeProvider } from './wallet';
import { readAwardCsv, IMPORT_COLUMNS, type ImportRow } from '../shared/import';

type Page = 'overview' | 'awards' | 'approvals' | 'recipients' | 'treasury' | 'award';
type ModalKind = 'wallet' | 'treasury' | 'award' | 'fund' | 'review' | 'guide' | 'import' | null;
type Review = { plan: TransactionPlan; award?: Award; treasury?: Treasury; recipient?: string; amountRaw?: string };
const emptyNetwork: NetworkState = { connected: false, verified: false, name: NETWORK.name, genesis: NETWORK.genesis, finalizedBlock: 0, bestBlock: 0, specVersion: 0, blockSeconds: 6, existentialDepositRaw: '0', minVestedRaw: '0', maxSchedules: 0, depositBaseRaw: '0', depositFactorRaw: '0', lastSyncedBlock: 0, sponsorEnabled: false };
const nav: { key: Page; label: string; icon: typeof Wallet }[] = [
  { key: 'overview', label: 'Overview', icon: Grid2X2 },
  { key: 'awards', label: 'Awards', icon: Layers3 },
  { key: 'approvals', label: 'Approvals', icon: CheckCheck },
  { key: 'recipients', label: 'Recipients', icon: Users },
  { key: 'treasury', label: 'Treasury', icon: Wallet },
];
const ErrorContext = createContext('');
function route() {
  const [section = 'overview', id] = location.hash.slice(2).split('/');
  return { page: (id ? 'award' : nav.some(n => n.key === section) ? section : 'overview') as Page, id: id ?? '' };
}
function Money({ raw = '0', big = false }: { raw?: string; big?: boolean }) {
  return <span className={big ? 'money money-big' : 'money'} title={formatAmount(raw, 14) + ' tPOT'}>{formatAmount(raw, BigInt(raw) > 0n && BigInt(raw) < UNIT / 10_000n ? 14 : 4)} <span className="unit">tPOT</span></span>;
}
function Status({ award, block }: { award: Award; block: number }) {
  let status: string = award.status === 'awaiting_approval' ? 'Needs approval' : award.status === 'draft' ? 'Draft' : award.status === 'funded' ? block >= award.endBlock ? 'Fully vested' : block < award.startBlock ? 'Scheduled' : 'Vesting' : award.status === 'cancelled' ? 'Cancelled' : 'Failed';
  return <span className={'award-status award-status-' + award.status}><span className="status-dot" />{status}</span>;
}
function ReleaseProgress({ award, block, connected }: { award: Award; block: number; connected: boolean }) {
  const duration = Math.max(1, award.endBlock - award.startBlock);
  const elapsed = Math.max(0, Math.min(duration, block - award.startBlock));
  const funded = award.status === 'funded';
  const percent = funded ? elapsed / duration * 100 : 0;
  const before = block < award.startBlock;
  const complete = block >= award.endBlock;
  const active = connected && funded && !before && !complete;
  const inactive = award.status === 'cancelled' || award.status === 'failed';
  const label = !block ? 'Waiting for chain data' : inactive ? award.status === 'cancelled' ? 'Award cancelled' : 'Funding failed' : !funded ? 'Awaiting funding' : before ? 'Waiting to start' : complete ? 'Fully vested' : 'Vesting in progress';
  const caption = !block ? 'The schedule follows finalized Portaldot blocks.' : inactive ? 'No vesting schedule was funded for this award.' : !funded ? 'Vesting begins once this award is funded.' : before
    ? `${(award.startBlock - block).toLocaleString()} blocks until release begins`
    : complete ? 'Release schedule complete. Unlock any remaining vested funds below.'
    : `${elapsed.toLocaleString()} of ${duration.toLocaleString()} blocks · ${(award.endBlock - block).toLocaleString()} blocks remaining`;
  return <div className={'vesting-chart' + (active ? ' is-vesting' : '') + (complete && funded ? ' is-complete' : '')}>
    <div className="schedule-progress-heading"><span><span className={'connection-dot ' + (connected ? 'online' : '')} />{label}</span><strong>{Math.floor(percent)}%</strong></div>
    <div className="schedule-progress-track" role="progressbar" aria-label="Finalized blocks through the vesting schedule" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={funded ? elapsed : 0} aria-valuetext={caption}>
      <div className="schedule-progress-fill" style={{ width: percent + '%' }} />
      <span className="schedule-block-marker" style={{ left: percent + '%' }}>{complete && funded ? <Check size={10} /> : null}</span>
    </div>
    <div className="chart-markers"><span>Start<strong>#{award.startBlock.toLocaleString()}</strong></span><span className="current-block">Current finalized<strong>{block ? '#' + block.toLocaleString() : '—'}</strong></span><span>End<strong>#{award.endBlock.toLocaleString()}</strong></span></div>
    <p className="schedule-progress-caption" aria-live="polite">{caption}{!connected && block > 0 ? ' · Connection paused' : ''}</p>
  </div>;
}
function Modal({ title, eyebrow, children, close, busy }: { title: string; eyebrow?: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const error = useContext(ErrorContext);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="modal-box"><div className="modal-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={close}><X size={18} /></button></div>{error && <div className="alert error-alert modal-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}{children}</div>
    <form method="dialog" className="modal-backdrop"><button onClick={event => { event.preventDefault(); if (!busy) close(); }} disabled={busy}>Close</button></form>
  </dialog>;
}
function Empty({ icon: Icon = Layers3, title, text, action }: { icon?: typeof Layers3; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon size={23} strokeWidth={1.3} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

export default function App() {
  const [data, setData] = useState<Overview>({ network: emptyNetwork, treasuries: [], awards: [], session: null });
  const [page, setPage] = useState<Page>(route().page);
  const [awardId, setAwardId] = useState(route().id);
  const [treasuryId, setTreasuryId] = useState(localStorage.getItem('portaflow-treasury') || '');
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [detail, setDetail] = useState<AwardDetail | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [availableAccounts, setAvailableAccounts] = useState<NativeAccount[]>([]);
  const [availableProviders, setAvailableProviders] = useState<NativeProvider[]>([]);
  const [selectedWallet, setSelectedWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [review, setReview] = useState<Review | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const treasury = data.treasuries.find(t => t.id === treasuryId) ?? data.treasuries[0];
  const address = data.session?.address;
  const awards = data.awards.filter(a => a.treasuryId === treasury?.id);
  const pending = awards.filter(a => a.status === 'draft' || a.status === 'awaiting_approval');
  const funded = awards.filter(a => a.status === 'funded');
  const recipients = [...new Set(funded.map(a => a.recipient))];
  const committed = funded.reduce((sum, a) => sum + BigInt(a.totalRaw), 0n);
  const member = Boolean(address && treasury?.signatories.includes(address));
  const refresh = useCallback(async () => {
    try { await syncFinalizedReceipts(); } catch { /* Finalized receipt proofs retry on the next refresh. */ }
    try { setData(await request<Overview>('/overview')); setLoaded(true); }
    catch { setLoaded(true); setError('The PortaFlow service is unavailable. Check that the local server is running.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 6000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const handler = () => { const value = route(); setPage(value.page); setAwardId(value.id); setSearch(''); setFilter('all'); setMobileOpen(false); };
    addEventListener('hashchange', handler); return () => removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    let current = true;
    if (treasury && data.network.connected) {
      void request<WalletState>('/wallet/' + treasury.address).then(value => { if (current) setWallet(value); }).catch(() => { if (current) setWallet(null); });
    } else setWallet(null);
    return () => { current = false; };
  }, [treasury?.address, data.network.finalizedBlock, data.network.connected]);
  useEffect(() => {
    let current = true;
    if (page === 'award' && awardId) {
      void request<AwardDetail>('/awards/' + awardId).then(value => { if (current) setDetail(value); }).catch(e => { if (current) setError(e.message); });
    } else setDetail(null);
    return () => { current = false; };
  }, [page, awardId, data.network.finalizedBlock, data.awards]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { setError(''); }, [modal]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable && !modal) {
        const input = document.querySelector<HTMLInputElement>('.search-field input');
        if (input) { event.preventDefault(); input.focus(); }
      }
    };
    addEventListener('keydown', focusSearch); return () => removeEventListener('keydown', focusSearch);
  }, [modal]);
  const go = (next: Page, id?: string) => { location.hash = id ? '/awards/' + id : '/' + next; };
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setToast('Copied to clipboard'); } catch { setError('Clipboard access is unavailable. Select and copy the address manually.'); } };
  const act = async (fn: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'The action could not be completed.'); }
    finally { setBusy(false); setProgress(''); }
  };
  const openWallet = () => {
    setModal('wallet'); setAvailableAccounts([]); setAvailableProviders([]); setSelectedWallet('');
    void act(async () => { setAvailableProviders(await walletProviders()); });
  };
  const needWallet = (kind: ModalKind) => { if (!address) openWallet(); else setModal(kind); };
  const prepareAction = (kind: 'approval' | 'cancel' | 'unlock') => {
    if (!address) { openWallet(); return; }
    void act(async () => {
    if (!detail) return;
    const result = await request<TransactionPlan & { cancelled?: boolean }>('/awards/' + detail.award.id + '/' + kind + '-plan', {});
    if (result.cancelled) { await refresh(); setToast('Draft discarded'); return; }
    setReview({ plan: result, award: detail.award, treasury: detail.treasury, recipient: detail.award.recipient });
    setModal('review');
    });
  };
  const submitReview = () => void act(async () => {
    if (!review) return;
    try {
      await signTransaction(review.plan, review, setProgress);
      setModal(null); setToast('Transaction finalized on Portaldot');
    } finally {
      try { await syncFinalizedReceipts(); } catch { /* The verified receipt is retained for the next refresh. */ }
      await refresh();
    }
  });
  const selectedAwards = awards.filter(a => (page !== 'approvals' || ['draft', 'awaiting_approval'].includes(a.status))
    && (filter === 'all' || a.status === filter) && (a.title + ' ' + a.recipient).toLowerCase().includes(search.toLowerCase()));
  const network = data.network;
  const networkReady = network.connected && network.verified;
  const createButton = <><button className="btn btn-primary" disabled={Boolean(address && treasury && !member)} title={address && treasury && !member ? 'Connect a treasury signer to create awards' : undefined} onClick={() => needWallet(treasury ? 'award' : 'treasury')}><Plus size={16} />{treasury ? 'New award' : 'Create treasury'}</button>{page === 'awards' && treasury && <button className="btn btn-outline" disabled={Boolean(address && !member)} onClick={() => needWallet('import')}><Upload size={14} />Import CSV</button>}</>;

  function AwardTable({ compact = false }: { compact?: boolean }) {
    const rows = compact ? selectedAwards.slice(0, 5) : selectedAwards;
    return <div className="table-scroll"><table className="table award-table"><thead><tr><th>Award / recipient</th><th>Amount</th><th>Status</th><th>Release schedule</th><th aria-label="View award" /></tr></thead><tbody>
      {rows.map(award => <tr key={award.id}><td><button className="row-title" onClick={() => go('award', award.id)}><span className="row-file"><FileText size={17} /></span><span><strong>{award.title}</strong><small>{shortAddress(award.recipient)}</small></span></button></td><td><Money raw={award.totalRaw} /></td><td><Status award={award} block={network.finalizedBlock} /></td><td><span className="schedule-label">{Math.round(award.durationBlocks * network.blockSeconds / 86400) >= 1 ? Math.round(award.durationBlocks * network.blockSeconds / 86400) + ' days estimated' : award.durationBlocks + ' blocks'}</span><small className="muted">From #{award.startBlock.toLocaleString()}</small></td><td><button className="icon-button" aria-label={'Open ' + award.title} onClick={() => go('award', award.id)}><ChevronRight size={16} /></button></td></tr>)}
    </tbody></table>{!rows.length && <Empty title={search || filter !== 'all' ? 'No matching awards' : page === 'approvals' ? 'Your approval queue is clear' : 'Your first award starts here'}
      text={search || filter !== 'all' ? 'Try another search or status.' : 'Fund a contribution, agree on its release schedule, and give the recipient a clear path to their funds.'}
      action={!search && filter === 'all' && <button className="btn btn-outline btn-sm" onClick={() => needWallet(treasury ? 'award' : 'treasury')}><Plus size={14} />{treasury ? 'Create an award' : 'Set up a treasury'}</button>} />}</div>;
  }

  return <ErrorContext.Provider value={error}><div className={'app-shell' + (mobileOpen ? ' navigation-open' : '')}>
    <aside className="sidebar">
      <a className="brand" href="#/overview" aria-label="PortaFlow overview"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 6h14l6 6H10zM4 15h14l6 6H10z" fill="currentColor" /></svg><span>portaflow<span className="brand-period">.</span></span></a>
      <label className="workspace-select">{treasury ? <span className="workspace-avatar">{treasury.name.slice(0, 1).toUpperCase()}</span> : <span className="workspace-avatar"><Layers3 size={15} /></span>}
        <select aria-label="Treasury workspace" value={treasury?.id || ''} onChange={e => { setTreasuryId(e.target.value); localStorage.setItem('portaflow-treasury', e.target.value); }}>
          {!data.treasuries.length && <option value="">Your workspace</option>}{data.treasuries.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select><ChevronDown size={13} />
      </label>
      <div className="nav-section-label">WORKSPACE</div>
      <nav className="menu">{nav.map(item => <a key={item.key} href={'#/' + item.key} className={page === item.key || page === 'award' && item.key === 'awards' ? 'nav-active' : ''}><item.icon size={17} strokeWidth={1.6} /><span>{item.label}</span>{item.key === 'approvals' && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><ShieldCheck size={17} /><span>Your wallets.<br /><strong>Your treasury.</strong></span><button className="icon-button" aria-label="How PortaFlow works" onClick={() => setModal('guide')}><ArrowUpRight size={14} /></button></div>
        <button className="nav-secondary" onClick={() => setModal('guide')}><CircleHelp size={16} />How it works<ArrowUpRight size={13} /></button>
        <a className="nav-secondary" href="https://portaldot-dev.readthedocs.io/en/latest/" target="_blank" rel="noreferrer"><FileText size={16} />Portaldot docs<ExternalLink size={12} /></a>
        <div className="sidebar-network"><span className={'connection-dot ' + (networkReady ? 'online' : '')} /><span>Portaldot testnet</span><span className="version">v3</span></div>
      </div>
    </aside>
    {mobileOpen && <button className="navigation-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <div className="workspace">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button><span className="breadcrumb-workspace">{treasury?.name || 'Workspace'}</span><ChevronRight size={12} /><strong>{page === 'award' ? 'Award details' : nav.find(n => n.key === page)?.label}</strong></div>
        <div className="topbar-actions"><span className="testnet-label">Testnet</span><button className="wallet-button" onClick={openWallet}><Wallet size={15} />{address ? shortAddress(address) : 'Connect wallet'}<ChevronDown size={12} /></button></div></header>
      <main>
        {!networkReady && loaded && <div className="network-notice"><LoaderCircle size={15} className="spin" /><span>{network.error || 'Connecting to Portaldot V3. Chain actions become available after network verification.'}</span></div>}
        {page !== 'award' && <div className="page-heading"><div><div className="eyebrow">{page === 'overview' ? 'YOUR FUNDING WORKSPACE' : 'WORKSPACE / ' + page.toUpperCase()}</div><h1>{page === 'overview' ? 'Treasury overview' : nav.find(n => n.key === page)?.label}</h1><p>{page === 'overview' ? 'Commit funding. Keep everyone in the loop.' : page === 'approvals' ? 'Review the exact terms before your treasury commits funds.' : page === 'treasury' ? 'A shared treasury, controlled by its signers.' : page === 'recipients' ? 'The people and teams your treasury has funded.' : 'Every contribution, with a clear funding commitment.'}</p></div><div className="heading-actions">{page === 'treasury' && treasury && <button className="btn btn-outline" onClick={() => needWallet('treasury')}><Plus size={15} />New treasury</button>}{createButton}</div></div>}

        {page === 'overview' && <>
          <div className="stats-strip">
            <div className="stat-item"><span>Available to award <Wallet size={14} /></span><strong>{wallet ? <Money raw={wallet.spendableRaw} /> : <span className="unknown-amount">— <span>tPOT</span></span>}</strong><small>{treasury ? 'After minimum account balance' : 'Set up your shared treasury'}</small></div>
            <div className="stat-item"><span>Total funded <ArrowUpRight size={14} /></span><strong><Money raw={committed.toString()} /></strong><small>{funded.length} funded award{funded.length !== 1 ? 's' : ''}</small></div>
            <div className="stat-item"><span>Awaiting approval <Clock3 size={14} /></span><strong>{pending.length}<span className="stat-word"> awards</span></strong><small>Review with your treasury signers</small></div>
            <div className="stat-item"><span>Recipients <Users size={14} /></span><strong>{recipients.length}<span className="stat-word"> wallets</span></strong><small>Funded directly on Portaldot</small></div>
          </div>
          <div className="overview-grid">
            <section className="panel schedule-panel"><div className="panel-heading"><div><h2>Funding schedule</h2><p>Awarded funds and their release progress.</p></div><span className="subtle-label"><span className="connection-dot online" />{funded.length} funded</span></div>
              {funded.length ? <div className="schedule-list">{funded.slice(0, 4).map(award => {
                const remaining = vestedRemaining(BigInt(award.lockedRaw), BigInt(award.perBlockRaw), award.startBlock, network.finalizedBlock);
                const percent = Number((BigInt(award.lockedRaw) - remaining) * 100n / BigInt(award.lockedRaw));
                return <button className="schedule-row" key={award.id} onClick={() => go('award', award.id)}><div className="schedule-row-heading"><span>{award.title}</span><Money raw={award.totalRaw} /></div><progress className="progress" value={percent} max={100} /><div className="schedule-row-caption"><span>{percent}% of vested portion earned</span><span>Through #{award.endBlock.toLocaleString()}</span></div></button>;
              })}</div> : <div className="schedule-empty"><div className="release-illustration" aria-hidden="true"><span /><span /><span /><span /><span /><span /><i /></div><h3>A clear path from award to unlock.</h3><p>Your funded awards will appear here, with progress<br className="desktop-break" /> read from finalized Portaldot blocks.</p><button className="text-button" onClick={() => setModal('guide')}>See how funding works <ArrowRight size={14} /></button></div>}
              <div className="panel-footnote"><ShieldCheck size={13} />Funded vesting is enforced by the chain.</div>
            </section>
            <section className="panel treasury-summary"><div className="panel-heading"><h2>Your treasury</h2><Wallet size={16} className="muted" /></div>
              {treasury ? <><div className="treasury-name"><span className="treasury-monogram">{treasury.name.slice(0, 2).toUpperCase()}</span><div><strong>{treasury.name}</strong><small>{treasury.threshold} of {treasury.signatories.length} approvals required</small></div></div><div className="address-box"><code>{shortAddress(treasury.address)}</code><button className="icon-button" aria-label="Copy treasury address" onClick={() => void copy(treasury.address)}><Copy size={13} /></button></div><dl className="compact-details"><div><dt>Balance</dt><dd>{wallet ? <Money raw={wallet.freeRaw} /> : '—'}</dd></div><div><dt>Approval policy</dt><dd>{treasury.threshold} / {treasury.signatories.length} signers</dd></div><div><dt>Network</dt><dd>Portaldot V3</dd></div></dl><button className="btn btn-outline full-width" onClick={() => needWallet('fund')}><Plus size={14} />Add funds</button></> :
                <div className="treasury-onboarding"><div className="treasury-outline"><Wallet size={27} strokeWidth={1.1} /></div><h3>Make it a shared commitment.</h3><p>Choose your signers and approval threshold. Your team stays in control of the funds.</p><button className="btn btn-outline full-width" onClick={() => needWallet('treasury')}>Create treasury <ArrowRight size={14} /></button></div>}
            </section>
          </div>
          <section className="panel"><div className="panel-heading"><div><h2>Recent awards</h2><p>Funding commitments, approvals, and recipients.</p></div><button className="btn btn-ghost btn-sm" onClick={() => go('awards')}>View all <ArrowUpRight size={14} /></button></div><AwardTable compact /></section>
        </>}

        {(page === 'awards' || page === 'approvals') && <section className="panel"><div className="panel-heading table-toolbar"><div className="table-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All awards <span>{page === 'approvals' ? pending.length : awards.length}</span></button>{page === 'awards' && <><button className={filter === 'funded' ? 'active' : ''} onClick={() => setFilter('funded')}>Funded</button><button className={filter === 'awaiting_approval' ? 'active' : ''} onClick={() => setFilter('awaiting_approval')}>Needs approval</button></>}</div><label className="search-field"><Search size={15} /><input aria-label="Search awards" placeholder="Search awards…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>/</kbd></label></div><AwardTable /></section>}

        {page === 'recipients' && <section className="panel"><div className="panel-heading"><h2>Funded recipients <span className="count-label">{recipients.length}</span></h2></div>{recipients.length ? <div className="recipient-list">{recipients.map((recipient, i) => <div className="recipient-row" key={recipient}><span className="person-avatar">{String(i + 1).padStart(2, '0')}</span><div><strong>{shortAddress(recipient)}</strong><small>{funded.filter(a => a.recipient === recipient).length} funded awards</small></div><Money raw={funded.filter(a => a.recipient === recipient).reduce((sum, a) => sum + BigInt(a.totalRaw), 0n).toString()} /><button className="icon-button" aria-label="Copy recipient address" onClick={() => void copy(recipient)}><Copy size={14} /></button></div>)}</div> : <Empty icon={Users} title="Good work starts with people" text="Recipients appear here when an award has been funded on-chain." />}</section>}

        {page === 'treasury' && (treasury ? <div className="treasury-grid"><section className="panel"><div className="panel-heading"><h2>{treasury.name}</h2><ShieldCheck size={17} /></div><div className="treasury-balance"><span className="muted">Available to award</span><Money big raw={wallet?.spendableRaw || '0'} /><button className="btn btn-primary" onClick={() => needWallet('fund')}><Plus size={15} />Add funds</button></div><div className="full-address"><span>Treasury address</span><code>{treasury.address}</code><button className="icon-button" aria-label="Copy full treasury address" onClick={() => void copy(treasury.address)}><Copy size={14} /></button></div><dl className="compact-details padded-details"><div><dt>Approval threshold</dt><dd>{treasury.threshold} of {treasury.signatories.length} signers</dd></div><div><dt>Minimum account balance</dt><dd><Money raw={network.existentialDepositRaw} /></dd></div><div><dt>Native token</dt><dd>tPOT · 14 decimals</dd></div></dl></section><section className="panel"><div className="panel-heading"><h2>Treasury signers</h2><span className="count-label">{treasury.signatories.length}</span></div><div className="signer-list">{treasury.signatories.map((signer, i) => <div className="signer-row" key={signer}><span className="person-avatar">{String(i + 1).padStart(2, '0')}</span><div><strong>{signer === address ? 'Your wallet' : 'Signer ' + (i + 1)}</strong><small>{shortAddress(signer)}</small></div><button className="icon-button" aria-label="Copy signer address" onClick={() => void copy(signer)}><Copy size={14} /></button></div>)}</div><div className="info-block"><ShieldCheck size={16} /><p>The signer set determines this treasury address. A different signer set creates a different treasury.</p></div></section></div> : <section className="panel"><Empty icon={Wallet} title="Give your team a treasury" text="Set an approval policy and fund a shared native account." action={<button className="btn btn-primary" onClick={() => needWallet('treasury')}><Plus size={15} />Create treasury</button>} /></section>)}

        {page === 'award' && (detail?.award.id === awardId ? <>
          <button className="back-link" onClick={() => go('awards')}><ChevronLeft size={14} />All awards</button>
          <div className="page-heading detail-heading"><div><div className="eyebrow">AWARD / {detail.award.id.slice(0, 8)}</div><h1>{detail.award.title}</h1><div className="detail-subtitle"><Status award={detail.award} block={network.finalizedBlock} /><span>Created {new Date(detail.award.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div><div className="heading-actions"><button className="btn btn-outline" onClick={() => void copy(location.href)}><Link2 size={14} />Share</button><a className="btn btn-outline" href={'/api/awards/' + detail.award.id + '/receipt'} download><Download size={14} />Receipt</a></div></div>
          {detail.reviewRequired && detail.award.status !== 'funded' && <div className="warning-notice"><AlertCircle size={17} /><span>The start block has passed or the runtime has changed. Cancel a pending proposal and create a new award before approving.</span></div>}
          {detail.award.failure && <div className="warning-notice"><AlertCircle size={17} />{detail.award.failure}</div>}
          <div className="detail-grid"><div className="detail-main">
            <section className="panel award-amount-panel"><div className="panel-heading"><span className="muted">Total award</span><span className="testnet-label">Native tPOT</span></div><Money big raw={detail.award.totalRaw} /><div className="award-split"><div><span className="legend-dot immediate" /><span>Immediate payment</span><strong><Money raw={detail.award.upfrontRaw} /></strong></div><div><span className="legend-dot vested" /><span>Funded vesting</span><strong><Money raw={detail.award.lockedRaw} /></strong></div></div>
              <div className="split-track"><span style={{ width: Number(BigInt(detail.award.upfrontRaw) * 100n / BigInt(detail.award.totalRaw)) + '%' }} /><span /></div>
            </section>
            <section className="panel"><div className="panel-heading"><div><h2>Release schedule</h2><p>Calculated from actual Portaldot blocks.</p></div><Clock3 size={16} className="muted" /></div><div className="vesting-body"><div className="vesting-amounts"><div><small>Earned from vested portion</small><strong><Money raw={detail.vestedRaw} /></strong></div><div><small>Scheduled remainder</small><strong><Money raw={detail.remainingRaw} /></strong></div></div>
              <ReleaseProgress award={detail.award} block={network.finalizedBlock} connected={networkReady} />
              <p className="fine-print">Native vesting transfers funds upfront and locks their use. Unlocking updates the wallet’s vesting lock. Its balance may include other awards.</p>
              {detail.award.status === 'funded' && <><div className="unlock-box"><div><span>Eligible to unlock in recipient wallet</span><strong>{detail.wallet ? <Money raw={detail.wallet.eligibleUnlockRaw} /> : 'Waiting for chain data'}</strong></div><button className="btn btn-primary" disabled={!networkReady || busy || !detail.wallet || BigInt(detail.wallet.eligibleUnlockRaw) === 0n} onClick={() => prepareAction('unlock')}><ArrowDownLeft size={15} />{address === detail.award.recipient ? 'Unlock my funds' : 'Unlock for recipient'}</button></div><p className="unlock-explanation">Funds stay in the recipient’s wallet. The account that signs pays the network fee. {detail.wallet && BigInt(detail.wallet.vestingLockRaw) === 0n && network.finalizedBlock >= detail.award.endBlock ? 'The recipient’s vesting lock is already cleared.' : ''}</p></>}
            </div></section>
            <section className="panel"><div className="panel-heading"><h2>On-chain activity</h2><span className="subtle-label">{detail.receipts.length} finalized</span></div>{detail.receipts.length ? <div className="activity-list">{detail.receipts.map(receipt => <div className="activity-row" key={receipt.txHash}><span className={'activity-icon ' + (receipt.kind === 'failed' ? 'failed' : '')}>{receipt.kind === 'failed' ? <AlertCircle size={16} /> : <Check size={16} />}</span><div><strong>{receipt.kind === 'funding' ? 'Award funded' : receipt.kind === 'approval' ? 'Approval recorded' : receipt.kind === 'unlock' ? 'Vested funds unlocked' : receipt.kind === 'cancellation' ? 'Proposal cancelled' : 'Payment failed'}</strong><small>Block #{receipt.blockNumber.toLocaleString()} · {shortAddress(receipt.signer)}</small><button className="hash-link" title={receipt.txHash} onClick={() => void copy(receipt.txHash)}>{shortAddress(receipt.txHash)}<Copy size={11} /></button></div><div className="activity-fee"><Money raw={receipt.feeRaw} /><small>Network fee</small></div></div>)}</div> : <div className="activity-empty"><Clock3 size={16} /><p>Finalized approvals and payments will appear here.</p></div>}</section>
          </div><aside className="detail-aside">
            <section className="panel"><div className="panel-heading"><h2>Approval policy</h2><span className="count-label">{detail.award.status === 'funded' ? detail.treasury.threshold : detail.pending?.approvals.length || 0}/{detail.treasury.threshold}</span></div><div className="signer-list">{detail.treasury.signatories.map((signer, i) => {
              const approved = Boolean(detail.pending?.approvals.includes(signer) || detail.receipts.some(r => ['approval', 'funding'].includes(r.kind) && r.signer === signer));
              return <div className="signer-row" key={signer}><span className={'person-avatar ' + (approved ? 'approved' : '')}>{approved ? <Check size={15} /> : String(i + 1).padStart(2, '0')}</span><div><strong>{signer === address ? 'Your wallet' : 'Signer ' + (i + 1)}</strong><small>{shortAddress(signer)}</small></div><span className={'signer-state ' + (approved ? 'approved' : '')}>{approved ? 'Approved' : 'Pending'}</span></div>;
            })}</div>
              {['draft', 'awaiting_approval'].includes(detail.award.status) && <div className="approval-actions"><button className="btn btn-primary full-width" disabled={busy || !networkReady || detail.reviewRequired || Boolean(address && !detail.treasury.signatories.includes(address)) || Boolean(address && detail.pending?.approvals.includes(address))} onClick={() => address ? prepareAction('approval') : openWallet()}>{busy ? <LoaderCircle size={15} className="spin" /> : <CheckCheck size={16} />}{!address ? 'Connect to approve' : detail.pending?.approvals.includes(address) ? 'Waiting for another signer' : 'Review & approve'}</button>
                {(detail.pending?.depositor === address || !detail.pending && detail.award.status === 'draft' && detail.award.createdBy === address) && <button className="text-button danger" disabled={busy} onClick={() => prepareAction('cancel')}>{detail.pending ? 'Cancel proposal' : 'Discard draft'}</button>}</div>}
              <div className="info-block"><ShieldCheck size={16} /><p>{detail.treasury.threshold} signatures authorize the exact recipients, amounts, and release schedule.</p></div>
            </section>
            <section className="panel"><div className="panel-heading"><h2>Recipient</h2><Users size={15} className="muted" /></div><div className="recipient-detail"><span className="person-avatar"><Wallet size={17} /></span><code>{detail.award.recipient}</code><button className="icon-button" aria-label="Copy award recipient" onClick={() => void copy(detail.award.recipient)}><Copy size={14} /></button></div>{detail.award.workUrl && <a className="work-reference" href={detail.award.workUrl} target="_blank" rel="noreferrer"><Link2 size={14} />Work reference<ArrowUpRight size={14} /></a>}</section>
            <div className="commitment-note"><ShieldCheck size={17} /><p>Once funded, the sender cannot cancel this native vesting schedule. Funds are committed to the recipient.</p></div>
          </aside></div>
        </> : <div className="loading-detail"><LoaderCircle className="spin" size={22} /><p>Loading award from PortaFlow…</p></div>)}
        <footer className="workspace-footer"><span><span className={'connection-dot ' + (networkReady ? 'online' : '')} />{networkReady ? 'Connected to Portaldot V3' : 'Waiting for network'}</span><span>{network.finalizedBlock > 0 ? 'Finalized #' + network.finalizedBlock.toLocaleString() : 'Checking finalized head'}<span className="footer-divider">/</span>Funds stay on-chain</span></footer>
      </main>
    </div>

    {error && !modal && <div className="toast toast-end toast-bottom"><div className="alert error-alert" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div></div>}
    {toast && <div className="toast toast-end toast-bottom success-toast"><div className="alert" role="status"><CheckCircle2 size={17} /><span>{toast}</span></div></div>}
    {modal === 'wallet' && <Modal title={address ? 'Your wallet' : 'Connect your wallet'} eyebrow="NATIVE PORTALDOT ACCOUNT" close={() => setModal(null)} busy={busy}>
      <p className="modal-description">Choose a wallet to sign with your Portaldot native account. Only the wallet you select receives a connection request.</p>
      <div className="wallet-network"><span className={'connection-dot ' + (networkReady ? 'online' : '')} /><div><strong>Portaldot V3 Testnet <span>tPOT</span></strong><code>{NETWORK.rpc}</code></div><ShieldCheck size={17} /></div>
      {busy && <div className="wallet-loading"><LoaderCircle size={18} className="spin" />{availableAccounts.length ? 'Confirm the sign-in message in your wallet…' : selectedWallet ? 'Authorize ' + selectedWallet + ' to share your native accounts…' : 'Looking for installed native wallets…'}</div>}
      {!availableAccounts.length && <div className="wallet-options">{availableProviders.map(provider => <button key={provider.id} disabled={busy} className="wallet-option" onClick={() => void act(async () => {
        setSelectedWallet(provider.name);
        const found = await accounts(provider.id);
        setAvailableAccounts(found);
      })}><span className="wallet-option-icon"><Wallet size={20} /></span><span><strong>{provider.name}</strong><small>Use native accounts on Portaldot testnet</small></span><ChevronRight size={16} /></button>)}</div>}
      <div className="wallet-options">{availableAccounts.map(account => <button key={account.meta.source + account.address} disabled={busy} className="wallet-option" onClick={() => void act(async () => { await login(account); setModal(null); await refresh(); setToast('Wallet connected'); })}><span className="wallet-option-icon"><Wallet size={20} /></span><span><strong>{account.meta.name || 'Native wallet'}</strong><small>{shortAddress(account.address)} · {providerName(account.meta.source)}</small></span><ChevronRight size={16} /></button>)}</div>
      {availableAccounts.some(account => account.meta.genesisHash && account.meta.genesisHash !== NETWORK.genesis) && <div className="wallet-network-help"><p>Your wallet associates an account with another network. You can sign in with the same native account; funding actions will explicitly request Portaldot V3 testnet.</p></div>}
      {!busy && !availableProviders.length && <div className="wallet-guidance"><h3>Connect a Portaldot native account</h3><p>No compatible native wallet was detected. Portaldot’s website links its browser extension below. After installing or enabling a wallet, reload this page.</p><div><a className="btn btn-outline btn-sm" href="https://chromewebstore.google.com/detail/portaldot-extension/cpdecangbhmfijmlmjglfcocfpaojceo" target="_blank" rel="noreferrer">Portaldot Wallet <ArrowUpRight size={13} /></a><a className="btn btn-ghost btn-sm" href="https://www.portaldot.world/" target="_blank" rel="noreferrer">Official website <ArrowUpRight size={13} /></a></div><button className="btn btn-ghost btn-sm" onClick={openWallet}><RefreshCw size={13} />Check installed wallets</button></div>}
      {!busy && availableProviders.length > 0 && <div className="wallet-network-help"><p>Transactions use Portaldot testnet and tPOT. Your wallet supplies the signing account; PortaFlow verifies the chain before signing.</p><a className="text-button" href="https://chromewebstore.google.com/detail/portaldot-extension/cpdecangbhmfijmlmjglfcocfpaojceo" target="_blank" rel="noreferrer">Get Portaldot Wallet <ArrowUpRight size={12} /></a>{availableAccounts.length > 0 && <button className="text-button" disabled={busy} onClick={openWallet}>Choose another wallet</button>}</div>}
      {address && <div className="wallet-current"><span>Signed in as <code>{shortAddress(address)}</code></span><button className="text-button" onClick={() => void act(async () => { await request('/auth/logout', {}); setModal(null); await refresh(); })}><LogOut size={13} />Disconnect</button></div>}
    </Modal>}
    {modal === 'treasury' && <TreasuryForm address={address || ''} busy={busy} close={() => setModal(null)} submit={values => void act(async () => { const created = await request<Treasury>('/treasuries', values); setTreasuryId(created.id); localStorage.setItem('portaflow-treasury', created.id); setModal(null); await refresh(); go('treasury'); setToast('Treasury workspace created'); })} />}
    {modal === 'award' && treasury && <AwardForm treasury={treasury} network={network} busy={busy} close={() => setModal(null)} submit={values => void act(async () => { const created = await request<Award>('/awards', values); setModal(null); await refresh(); go('award', created.id); setToast('Award ready for treasury approval'); })} />}
    {modal === 'import' && treasury && <ImportForm treasury={treasury} busy={busy} close={() => setModal(null)} submit={values => void act(async () => { const result = await request<{ awards: Award[] }>('/awards/import', values); setModal(null); await refresh(); go('awards'); setToast(result.awards.length + ' award drafts imported'); })} />}
    {modal === 'fund' && treasury && <FundingForm treasury={treasury} busy={busy} close={() => setModal(null)} submit={amount => void act(async () => { const plan = await request<TransactionPlan>('/treasuries/' + treasury.id + '/funding-plan', { amount }); setReview({ plan, treasury, amountRaw: parseAmount(amount).toString() }); setModal('review'); })} />}
    {modal === 'review' && review && <Modal title="Review transaction" eyebrow={review.plan.kind.toUpperCase()} busy={busy} close={() => setModal(null)}><div className="review-target"><ShieldCheck size={23} /><div><strong>{review.award?.title || (review.plan.kind === 'treasury funding' ? 'Fund ' + review.treasury?.name : 'Unlock vested funds')}</strong><small>{review.plan.kind === 'approval' ? 'Records your approval. A later signer completes funding.' : review.plan.kind === 'funding' ? 'This signature executes the approved award.' : 'Signed in your native wallet.'}</small></div></div>
      <dl className="review-details">{review.award && review.plan.kind !== 'unlock' && <><div><dt>Total award</dt><dd><Money raw={review.award.totalRaw} /></dd></div><div><dt>Immediate / vested</dt><dd>{formatAmount(review.award.upfrontRaw)} / {formatAmount(review.award.lockedRaw)} tPOT</dd></div><div><dt>Start / end block</dt><dd>#{review.award.startBlock} / #{review.award.endBlock}</dd></div></>}{review.recipient && <div><dt>Recipient</dt><dd title={review.recipient}>{shortAddress(review.recipient)}</dd></div>}{review.plan.kind === 'unlock' && <div><dt>Action</dt><dd>Update recipient’s vesting lock</dd></div>}{review.amountRaw && <div><dt>Transfer amount</dt><dd><Money raw={review.amountRaw} /></dd></div>}<div><dt>Signing wallet / fee payer</dt><dd>{shortAddress(review.plan.signer)}</dd></div><div><dt>Estimated network fee</dt><dd><Money raw={review.plan.feeRaw} /></dd></div>{BigInt(review.plan.depositRaw) > 0n && <div><dt>Refundable approval deposit</dt><dd><Money raw={review.plan.depositRaw} /></dd></div>}<div><dt>Network</dt><dd>Portaldot V3 Testnet</dd></div></dl>
      <p className="fine-print">The browser verifies the encoded transaction against these terms before opening your wallet. Your wallet may first ask to add Portaldot’s network details. Network fees are estimates; the wallet shows the final signing request.</p><div className="modal-footer"><button className="btn btn-outline" disabled={busy} onClick={() => setModal(null)}>Back</button><button className="btn btn-primary" disabled={busy} onClick={submitReview}>{busy ? <LoaderCircle size={15} className="spin" /> : <Wallet size={15} />}{busy ? progress || 'Preparing wallet…' : 'Confirm in wallet'}</button></div>
    </Modal>}
    {modal === 'guide' && <Modal title="A clear funding commitment." eyebrow="HOW PORTAFLOW WORKS" close={() => setModal(null)}><div className="guide-steps">{[
      ['01', 'Set up a shared treasury', 'Choose native wallet signers and an approval threshold. Fund its address with testnet tPOT.'],
      ['02', 'Agree on an award', 'Specify the recipient, immediate payment, and block-based vesting schedule.'],
      ['03', 'Approve the exact terms', 'Treasury signers authorize an atomic payment and funded native vesting transfer.'],
      ['04', 'Unlock as funds vest', 'Recipients or helpers can update the vesting lock. Every finalized action has a receipt.'],
    ].map(([number, title, description]) => <div className="guide-step" key={number}><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></div>)}</div><div className="info-block"><ShieldCheck size={18} /><p>Funded schedules cannot be cancelled by their sender. Calendar estimates depend on block production. An optional, separately funded sponsor can cover unlock fees.</p></div></Modal>}
  </div></ErrorContext.Provider>;
}

function TreasuryForm({ address, busy, close, submit }: { address: string; busy: boolean; close: () => void; submit: (data: unknown) => void }) {
  const [name, setName] = useState('');
  const [signers, setSigners] = useState(['', '']);
  const [threshold, setThreshold] = useState(2);
  const actual = [address, ...signers.filter(s => s.trim())];
  useEffect(() => { if (threshold > actual.length) setThreshold(Math.max(2, actual.length)); }, [actual.length, threshold]);
  return <Modal title="Create a shared treasury" eyebrow="TREASURY SETUP" close={close} busy={busy}><p className="modal-description">Choose who can approve awards. This signer set determines your treasury’s native address.</p><form onSubmit={(e: FormEvent) => { e.preventDefault(); submit({ name, signatories: actual, threshold }); }}>
    <label className="field-label">Treasury name<input className="input" required maxLength={60} placeholder="e.g. Builder grants" value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="field-label">Signer 1 · your wallet<input className="input mono-input" value={address} readOnly /></label>
    {signers.map((signer, i) => <label className="field-label" key={i}>Signer {i + 2}{i > 0 && <span className="optional">optional</span>}<input className="input mono-input" required={i === 0} maxLength={64} placeholder="5…" value={signer} onChange={e => setSigners(signers.map((value, index) => index === i ? e.target.value : value))} /></label>)}
    {signers.length < 4 && <button type="button" className="text-button" onClick={() => setSigners([...signers, ''])}><Plus size={14} />Add another signer</button>}
    <label className="field-label">Required approvals<select className="select" value={threshold} onChange={e => setThreshold(Number(e.target.value))}>{Array.from({ length: Math.max(1, actual.length - 1) }, (_, i) => i + 2).map(value => <option key={value} value={value}>{value} of {Math.max(2, actual.length)} signers</option>)}</select></label>
    <p className="fine-print">Creating the workspace has no network fee. Funding and approval transactions use tPOT.</p><div className="modal-footer"><button type="button" className="btn btn-outline" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}Create treasury <ArrowRight size={14} /></button></div></form></Modal>;
}
function AwardForm({ treasury, network, busy, close, submit }: { treasury: Treasury; network: NetworkState; busy: boolean; close: () => void; submit: (data: unknown) => void }) {
  const [title, setTitle] = useState(''), [recipient, setRecipient] = useState(''), [amount, setAmount] = useState(''), [percent, setPercent] = useState(20), [duration, setDuration] = useState('30'), [reference, setReference] = useState(''), [accepted, setAccepted] = useState(false);
  const [delayHours, setDelayHours] = useState('24');
  let total = 0n; try { total = parseAmount(amount); } catch { /* Form validity is checked again on the server. */ }
  const upfront = total * BigInt(percent) / 100n;
  const decimal = (value: bigint) => (value / UNIT).toString() + '.' + (value % UNIT).toString().padStart(14, '0');
  const demo = duration === 'testnet';
  return <Modal title="Create an award" eyebrow={treasury.name.toUpperCase()} close={close} busy={busy}><form onSubmit={e => { e.preventDefault(); submit({ treasuryId: treasury.id, title, recipient, amount, upfront: upfront === 0n ? '0' : decimal(upfront), durationBlocks: demo ? 10 : Math.round(Number(duration) * 86400 / network.blockSeconds), startDelayBlocks: demo ? 100 : Math.round(Number(delayHours) * 3600 / network.blockSeconds), workUrl: reference, acceptedCommitment: accepted }); }}>
    <label className="field-label">Award title<input className="input" required maxLength={100} placeholder="e.g. Developer documentation grant" value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label className="field-label">Recipient’s native address<input className="input mono-input" required maxLength={64} placeholder="5…" value={recipient} onChange={e => setRecipient(e.target.value)} /></label>
    <div className="form-columns"><label className="field-label">Total award<div className="amount-input"><input className="input" required inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} /><span>tPOT</span></div></label><label className="field-label">Immediate payment<select className="select" value={percent} onChange={e => setPercent(Number(e.target.value))}>{[0, 10, 20, 25, 50].map(value => <option key={value} value={value}>{value}% upfront</option>)}</select></label></div>
    <div className="form-split"><div><span>Immediate</span><Money raw={upfront.toString()} /></div><div><span>Vested</span><Money raw={(total - upfront).toString()} /></div></div>
    <label className="field-label">Release duration<select className="select" value={duration} onChange={e => setDuration(e.target.value)}><option value="7">About 7 days</option><option value="30">About 30 days</option><option value="90">About 90 days</option><option value="testnet">Short testnet schedule · 10 blocks</option></select></label>
    {!demo && <label className="field-label">Start after creation<select className="select" value={delayHours} onChange={e => setDelayHours(e.target.value)}><option value="1">About 1 hour</option><option value="6">About 6 hours</option><option value="24">About 24 hours</option><option value="72">About 3 days</option><option value="168">About 7 days</option></select></label>}
    <p className="field-help">{demo ? 'Starts 100 blocks after creation (about 10 minutes); vests over 10 real testnet blocks. Complete all approvals before its start block.' : 'All signers must approve before the start block. Dates are estimates; the fixed block schedule is shown before approval.'}</p>
    <label className="field-label">Work reference <span className="optional">optional · public</span><input className="input" type="url" maxLength={500} placeholder="https://github.com/…" value={reference} onChange={e => setReference(e.target.value)} /></label>
    <label className="commitment-checkbox"><input className="checkbox checkbox-sm" type="checkbox" checked={accepted} required onChange={e => setAccepted(e.target.checked)} /><span>I understand that once funded, the vested funds are committed to the recipient and cannot be cancelled by the sender.</span></label>
    <div className="modal-footer"><button type="button" className="btn btn-outline" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || !network.verified || !accepted}>{busy && <LoaderCircle size={15} className="spin" />}Create award <ArrowRight size={14} /></button></div></form></Modal>;
}
function FundingForm({ treasury, busy, close, submit }: { treasury: Treasury; busy: boolean; close: () => void; submit: (amount: string) => void }) {
  const [amount, setAmount] = useState('');
  return <Modal title="Fund your treasury" eyebrow={treasury.name.toUpperCase()} close={close} busy={busy}><p className="modal-description">Transfer tPOT from your connected wallet to the shared treasury. Your signers control how it is awarded.</p><form onSubmit={e => { e.preventDefault(); submit(amount); }}><label className="field-label">Amount<div className="amount-input"><input className="input" required inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /><span>tPOT</span></div></label><div className="full-address"><span>Receiving treasury</span><code>{treasury.address}</code></div><div className="modal-footer"><button type="button" className="btn btn-outline" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}Review transfer <ArrowRight size={14} /></button></div></form></Modal>;
}

function ImportForm({ treasury, busy, close, submit }: { treasury: Treasury; busy: boolean; close: () => void; submit: (data: unknown) => void }) {
  const [csv, setCsv] = useState(''), [rows, setRows] = useState<ImportRow[]>([]), [filename, setFilename] = useState(''), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  const load = async (file?: File) => {
    setError(''); setRows([]); setCsv(''); setFilename(file?.name || '');
    if (!file) return;
    try {
      if (file.size > 40_000) throw new Error('Keep the CSV under 40 KB and 25 awards.');
      const source = await file.text(); const parsed = readAwardCsv(source);
      for (let i = 0; i < parsed.length; i++) {
        try { normalize(parsed[i].recipient); } catch { throw new Error('Row ' + (i + 2) + ': enter a valid native recipient address.'); }
      }
      setCsv(source); setRows(parsed);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this CSV.'); }
  };
  const template = () => {
    const url = URL.createObjectURL(new Blob([IMPORT_COLUMNS.join(',') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'portaflow-awards.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Modal title="Import contributor awards" eyebrow={treasury.name.toUpperCase()} busy={busy} close={close}>
    <p className="modal-description">Bring in up to 25 awards from your spreadsheet. Each creates a draft for your treasury signers to review and approve individually.</p>
    <button className="text-button" onClick={template}><Download size={14} />Download CSV template</button>
    <label className="import-file"><Upload size={22} strokeWidth={1.5} /><strong>{filename || 'Choose a CSV file'}</strong><span>CSV · up to 40 KB · 25 awards</span><input aria-label="Award CSV file" type="file" accept=".csv,text/csv" disabled={busy} onChange={e => void load(e.target.files?.[0])} /></label>
    {error && <div className="alert error-alert modal-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
    {rows.length > 0 && <div className="import-preview"><div><strong>{rows.length} award{rows.length !== 1 ? 's' : ''}</strong><Money raw={rows.reduce((sum, row) => sum + parseAmount(row.amount), 0n).toString()} /></div><ul>{rows.map((row, i) => <li key={i}><span><strong>{row.title}</strong><small>{shortAddress(row.recipient)} · {row.durationDays} days</small></span><Money raw={parseAmount(row.amount).toString()} /></li>)}</ul></div>}
    <p className="fine-print">Required columns: title, recipient, amount. Optional: upfront_percent (default 20), duration_days (default 30), work_url. All schedules start about 24 hours after import; blocks determine the exact timing.</p>
    <label className="commitment-checkbox"><input className="checkbox checkbox-sm" type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>I understand that funded native vesting awards cannot be cancelled by the sender. Importing these drafts does not transfer funds.</span></label>
    <div className="modal-footer"><button className="btn btn-outline" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || !rows.length || !accepted} onClick={() => submit({ treasuryId: treasury.id, csv, acceptedCommitment: accepted })}>{busy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}Import {rows.length || ''} drafts</button></div>
  </Modal>;
}
