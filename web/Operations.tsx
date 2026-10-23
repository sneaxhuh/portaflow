import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronLeft, Download, FileCheck2, Layers3, LoaderCircle, Plus, ShieldCheck, Trash2, Upload, Wallet } from 'lucide-react';
import type { NetworkState, PayoutRound, RecipientPortal, RoundDetail, TransactionPlan, Treasury, TreasuryLedger, Verification } from '../shared/types';
import { formatAmount, parseAmount, shortAddress, UNIT, vestedRemaining } from '../shared/money';
import { IMPORT_COLUMNS, readAwardCsv, type ImportRow } from '../shared/import';
import { request } from './api';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import { Progress } from './components/ui/progress';

export type PaymentReview = { plan: TransactionPlan; round?: PayoutRound; treasury?: Treasury; recipient?: string };
const message = (e: unknown) => e instanceof Error ? e.message : 'The request could not be completed.';
const decimal = (n: bigint) => (n / UNIT).toString() + '.' + (n % UNIT).toString().padStart(14, '0');
import { Amount, RoundStatus } from './RoundList';
function Notice({ children }: { children: ReactNode }) { return <div className="op-notice" role="alert">{children}</div>; }
function Loading() { return <div className="op-empty"><LoaderCircle className="spin" size={20} />Reading Portaldot…</div>; }
function Blank({ title, children }: { title: string; children: ReactNode }) { return <div className="op-empty"><Layers3 size={24} /><h3>{title}</h3><p>{children}</p></div>; }

type Row = { key: string; title: string; recipient: string; amount: string; percent: string; workUrl: string };
const newRow = (): Row => ({ key: crypto.randomUUID(), title: '', recipient: '', amount: '', percent: '100', workUrl: '' });
export function RoundForm({ treasury, network, busy, submit, close }: { treasury: Treasury; network: NetworkState; busy: boolean; submit: (value: unknown) => void; close: () => void }) {
  const [title, setTitle] = useState(''), [mode, setMode] = useState('manual'), [rows, setRows] = useState<Row[]>([newRow()]);
  const [csv, setCsv] = useState(''), [imported, setImported] = useState<ImportRow[]>([]), [filename, setFilename] = useState('');
  const [duration, setDuration] = useState('30'), [delay, setDelay] = useState('1'), [accepted, setAccepted] = useState(false), [error, setError] = useState('');
  const patch = (key: string, value: Partial<Row>) => setRows(rows.map(r => r.key === key ? { ...r, ...value } : r));
  const payments = mode === 'csv' ? imported : rows.map(r => {
    let total = 0n; try { total = parseAmount(r.amount); } catch { /* Validate on submit. */ }
    const upfront = total * BigInt(r.percent) / 100n;
    return { title: r.title, recipient: r.recipient, amount: r.amount, upfront: upfront ? decimal(upfront) : '0', workUrl: r.workUrl };
  });
  let total = 0n, immediate = 0n;
  for (const p of payments) { try { total += parseAmount(p.amount); immediate += p.upfront === '0' ? 0n : parseAmount(p.upfront); } catch { /* Incomplete row. */ } }
  const vested = total - immediate;
  const loadCsv = async (file?: File) => {
    setError(''); setCsv(''); setImported([]); setFilename(file?.name || '');
    if (!file) return;
    try {
      if (file.size > 40_000) throw new Error('Keep the CSV under 40 KB and 25 payments.');
      const source = await file.text(), parsed = readAwardCsv(source);
      const { normalize } = await import('./wallet');
      parsed.forEach(p => normalize(p.recipient)); setCsv(source); setImported(parsed);
    } catch (e) { setError(message(e)); }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      if (!payments.length) throw new Error('Add at least one payment.');
      const { normalize } = await import('./wallet');
      for (const [i, p] of payments.entries()) {
        normalize(p.recipient); const amount = parseAmount(p.amount), upfront = p.upfront === '0' ? 0n : parseAmount(p.upfront);
        if (amount - upfront > 0n && amount - upfront < BigInt(network.minVestedRaw)) throw new Error('Payment ' + (i + 1) + ': use 100% immediate or increase the vested portion to ' + formatAmount(network.minVestedRaw) + ' tPOT.');
      }
      const durationBlocks = duration === 'demo' ? 10 : Math.round(Number(duration) * 86400 / network.blockSeconds);
      submit({ treasuryId: treasury.id, title, acceptedCommitment: accepted,
        startDelayBlocks: duration === 'demo' ? 10 : Math.max(10, Math.round(Number(delay) * 3600 / network.blockSeconds)),
        ...(mode === 'csv' ? { csv } : { payments: payments.map(p => ({ ...p, durationBlocks })) }) });
    } catch (e) { setError(message(e)); }
  };
  return <form onSubmit={send} className="round-form">
    <p className="modal-description">Approve up to 25 payments together. Portaldot executes the entire batch atomically: every payment succeeds or all payment changes roll back.</p>
    <label className="field-label">Round name<Input required maxLength={100} placeholder="e.g. October contributor payments" value={title} onChange={e => setTitle(e.target.value)} /></label>
    <Tabs value={mode} onValueChange={v => { setMode(v); setDuration('30'); setError(''); }}><TabsList><TabsTrigger value="manual">Add payments</TabsTrigger><TabsTrigger value="csv">Import CSV</TabsTrigger></TabsList>
      <TabsContent value="manual"><div className="op-payment-editor">{rows.map((r, i) => <fieldset key={r.key} className="op-payment-row"><legend>Payment {String(i + 1).padStart(2, '0')}</legend><div className="op-row-controls"><Button type="button" variant="ghost" size="icon-xs" disabled={rows.length === 1 || busy} aria-label={'Remove payment ' + (i + 1)} onClick={() => setRows(rows.filter(a => a.key !== r.key))}><Trash2 /></Button></div>
        <label className="field-label">Contribution<Input required maxLength={100} placeholder="e.g. Documentation bounty" value={r.title} onChange={e => patch(r.key, { title: e.target.value })} /></label>
        <label className="field-label">Recipient address<Input required maxLength={64} className="op-monospace" placeholder="5…" value={r.recipient} onChange={e => patch(r.key, { recipient: e.target.value })} /></label>
        <div className="form-columns"><label className="field-label">Amount · tPOT<Input required inputMode="decimal" placeholder="0.00" value={r.amount} onChange={e => patch(r.key, { amount: e.target.value })} /></label><label className="field-label">Available immediately<select className="select" value={r.percent} onChange={e => patch(r.key, { percent: e.target.value })}>{[100, 50, 20, 0].map(n => <option key={n} value={n}>{n === 100 ? '100% · immediate payment' : n + '% · rest vests'}</option>)}</select></label></div>
        <label className="field-label">Work reference <span className="optional">optional</span><Input type="url" maxLength={500} placeholder="https://github.com/…" value={r.workUrl} onChange={e => patch(r.key, { workUrl: e.target.value })} /></label>
      </fieldset>)}</div><Button type="button" variant="outline" size="sm" disabled={rows.length >= 25 || busy} onClick={() => setRows([...rows, newRow()])}><Plus />Add payment</Button></TabsContent>
      <TabsContent value="csv"><label className="import-file"><Upload size={20} /><strong>{filename || 'Choose a CSV file'}</strong><span>Up to 25 payments · 40 KB</span><input type="file" accept=".csv,text/csv" onChange={e => void loadCsv(e.target.files?.[0])} /></label><p className="fine-print">Columns: <code>{IMPORT_COLUMNS.join(', ')}</code>. Set upfront_percent to 100 for immediate payments. duration_days applies to vested rows.</p>{imported.length > 0 && <div className="op-import-preview">{imported.map((r, i) => <div key={i}><span>{r.title}<small>{shortAddress(r.recipient)}</small></span><span>{r.amount} tPOT</span></div>)}</div>}</TabsContent>
    </Tabs>
    {vested > 0n && <div className="form-columns"><label className="field-label">Vesting duration{mode === 'csv' ? <p className="fine-print">Uses duration_days from each CSV row.</p> : <select className="select" value={duration} onChange={e => setDuration(e.target.value)}><option value="7">About 7 days</option><option value="30">About 30 days</option><option value="90">About 90 days</option><option value="demo">Demo · 10 blocks</option></select>}</label><label className="field-label">Approval window<select className="select" value={delay} onChange={e => setDelay(e.target.value)} disabled={duration === 'demo'}><option value="1">About 1 hour</option><option value="24">About 24 hours</option><option value="72">About 3 days</option></select></label></div>}
    {vested > 0n && <p className="fine-print">The schedule is fixed when the first signer reviews the round. Finish all approvals before the start block. {duration === 'demo' ? 'Demo starts 10 blocks after review and vests over 10 blocks.' : 'Calendar times are estimates based on block production.'}</p>}
    <div className="op-round-totals"><div><span>{payments.length} payments</span><Amount raw={total.toString()} /></div><div><span>Immediate</span><Amount raw={immediate.toString()} /></div><div><span>Vested</span><Amount raw={vested.toString()} /></div></div>
    <label className="commitment-checkbox"><input className="checkbox" type="checkbox" required checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>I have reviewed the recipients and amounts. Once funded, payments and native vesting commitments cannot be reversed by the treasury.</span></label>
    {error && <Notice>{error}</Notice>}
    <div className="modal-footer"><Button variant="outline" type="button" disabled={busy} onClick={close}>Cancel</Button><Button disabled={busy || !accepted || !network.connected || !network.verified || !total || !payments.length}>{busy ? <LoaderCircle className="spin" /> : <ArrowRight />}Create round</Button></div>
  </form>;
}

export function RoundPage({ id, block, network, address, busy, back, onReview, onWallet, refresh }: { id: string; block: number; network: NetworkState; address?: string; busy: boolean; back: () => void; onReview: (r: PaymentReview) => void; onWallet: () => void; refresh: () => Promise<void> }) {
  const [data, setData] = useState<RoundDetail | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  useEffect(() => { let live = true; void request<RoundDetail>('/rounds/' + id).then(d => { if (live) { setData(d); setError(''); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [id, block]);
  const plan = async (cancel = false) => {
    if (!address) return onWallet();
    setWorking(true); setError('');
    try {
      const response = await request<TransactionPlan & { round?: PayoutRound; cancelled?: boolean }>('/rounds/' + id + (cancel ? '/cancel-plan' : '/approval-plan'), {});
      if (response.cancelled) { await refresh(); setData(await request('/rounds/' + id)); }
      else { const round = response.round ?? data!.round; setData(d => d ? { ...d, round } : d); onReview({ plan: response, round, treasury: data!.treasury }); }
    } catch (e) { setError(message(e)); } finally { setWorking(false); }
  };
  if (!data || data.round.id !== id) return <>{error ? <Notice>{error}</Notice> : <Loading />}</>;
  const { round, treasury, pending, receipts } = data;
  const active = ['draft', 'awaiting_approval'].includes(round.status), member = address && treasury.signatories.includes(address);
  const approved = address && pending?.approvals.includes(address);
  return <div className="op-detail"><button className="back-link" onClick={back}><ChevronLeft size={14} />All rounds</button><div className="page-heading"><div><div className="eyebrow">PAYOUT ROUND / {id.slice(0, 8)}</div><h1>{round.title}</h1><p><RoundStatus round={round} /> <span className="op-subtitle">{round.awards.length} payments · {treasury.name}</span></p></div><div className="heading-actions"><Button variant="outline" asChild><a href={'/api/rounds/' + id + '/receipt'} download><Download />Receipt</a></Button></div></div>
    {error && <Notice>{error}</Notice>}{data.reviewRequired && active && <Notice>The approval window has passed or the runtime changed. The initiating signer must cancel the proposal, then create a new round.</Notice>}{round.failure && <Notice>{round.failure}</Notice>}
    <div className="op-detail-grid"><div className="op-stack"><Card className="op-card"><CardHeader><CardDescription>Total payout</CardDescription><div className="op-total"><Amount raw={round.totalRaw} /></div></CardHeader><CardContent><div className="op-round-totals"><div><span>Immediate</span><Amount raw={round.upfrontRaw} /></div><div><span>Native vesting</span><Amount raw={round.lockedRaw} /></div><div><span>Execution</span><strong>All or nothing</strong></div></div></CardContent></Card>
      <Card className="op-card"><CardHeader><CardTitle>Payment manifest</CardTitle><CardDescription>Every signer approves these same recipients, amounts, and schedules.</CardDescription></CardHeader><Table><TableHeader><TableRow><TableHead>Contribution / recipient</TableHead><TableHead>Immediate</TableHead><TableHead>Vested</TableHead><TableHead>Release</TableHead></TableRow></TableHeader><TableBody>{round.awards.map(a => {
        const remaining = vestedRemaining(BigInt(a.lockedRaw), BigInt(a.perBlockRaw), a.startBlock, block);
        const pct = round.status !== 'funded' ? 0 : a.lockedRaw === '0' ? 100 : Number((BigInt(a.lockedRaw) - remaining) * 100n / BigInt(a.lockedRaw));
        return <TableRow key={a.id}><TableCell><div className="op-payment-name"><strong>{a.title}</strong><code title={a.recipient}>{shortAddress(a.recipient)}</code>{a.workUrl && <a href={a.workUrl} target="_blank" rel="noreferrer">Work reference <ArrowUpRight size={11} /></a>}</div></TableCell><TableCell><Amount raw={a.upfrontRaw} /></TableCell><TableCell><Amount raw={a.lockedRaw} /></TableCell><TableCell className="op-release-cell">{a.lockedRaw === '0' ? <span>Immediate payment</span> : <><Progress value={pct} aria-label={a.title + ' vested'} /><small>{round.status === 'funded' ? pct + '% vested' : round.callHex ? 'Starts #' + a.startBlock.toLocaleString() : 'Starts after first review'}</small><small>{round.callHex ? '#' + a.startBlock.toLocaleString() + ' → #' + a.endBlock.toLocaleString() : a.durationBlocks.toLocaleString() + ' blocks'}</small></>}</TableCell></TableRow>;
      })}</TableBody></Table></Card>
      <Card className="op-card"><CardHeader><CardTitle>Execution evidence</CardTitle><CardDescription>{round.status === 'funded' ? 'Download the receipt and verify it against Portaldot without trusting this database.' : 'Finalized approvals and execution will appear here.'}</CardDescription></CardHeader><CardContent>{receipts.length ? receipts.map(r => <div className="op-evidence" key={r.txHash}><Check size={16} /><div><strong>{r.kind === 'funding' ? 'Entire round funded' : r.kind === 'approval' ? 'Approval recorded' : r.kind === 'cancellation' ? 'Proposal cancelled' : r.kind === 'unlock' ? 'Recipient lock updated' : 'Execution failed'}</strong><small>#{r.blockNumber.toLocaleString()} · {shortAddress(r.signer)}</small><code title={r.txHash}>{r.txHash}</code></div><Amount raw={r.feeRaw} /></div>) : <p className="fine-print">No finalized transactions yet.</p>}</CardContent></Card>
    </div><aside className="op-stack"><Card className="op-card"><CardHeader className="op-card-heading"><CardTitle>Shared approval</CardTitle><Badge variant="secondary">{round.status === 'funded' ? treasury.threshold : pending?.approvals.length || 0} / {treasury.threshold}</Badge></CardHeader><CardContent><div className="op-signers">{treasury.signatories.map((s, i) => {
      const signed = pending?.approvals.includes(s) || receipts.some(r => ['approval', 'funding'].includes(r.kind) && r.signer === s);
      return <div key={s}><span className={'op-signer-icon ' + (signed ? 'signed' : '')}>{signed ? <Check size={14} /> : i + 1}</span><span>{s === address ? 'Your wallet' : 'Signer ' + (i + 1)}<small title={s}>{shortAddress(s)}</small></span><small>{signed ? 'Approved' : 'Pending'}</small></div>;
    })}</div>{active && <><Button className="op-full" disabled={working || busy || !network.connected || !network.verified || data.reviewRequired || Boolean(address && (!member || approved))} onClick={() => void plan()}>{working ? <LoaderCircle className="spin" /> : <CheckCheck />}{!address ? 'Connect to approve' : approved ? 'Waiting for another signer' : 'Review & approve'}</Button>{(pending?.depositor === address || !pending && round.createdBy === address) && <Button variant="ghost" className="op-full op-discard" disabled={working || busy} onClick={() => void plan(true)}>{pending ? 'Cancel proposal' : 'Discard draft'}</Button>}</>}</CardContent></Card>
      <div className="op-explainer"><ShieldCheck size={18} /><p>One native multisig proposal authorizes the entire payment batch. Signers pay network fees; the treasury pays the recipients. The initiating signer’s approval deposit is refundable.</p></div>
      {round.termsHash && <Card className="op-card"><CardHeader><CardTitle>Committed terms</CardTitle><CardDescription>A fingerprint of the complete payment manifest, recorded on-chain when funded.</CardDescription></CardHeader><CardContent><code className="op-hash">{round.termsHash}</code></CardContent></Card>}
    </aside></div>
  </div>;
}

export function LedgerPage({ treasury, block }: { treasury?: Treasury; block: number }) {
  const [data, setData] = useState<TreasuryLedger | null>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; setError(''); if (treasury) void request<TreasuryLedger>('/treasuries/' + treasury.id + '/ledger').then(d => { if (live) setData(d); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [treasury?.id, block]);
  if (!treasury) return <Card className="op-card"><Blank title="Choose a treasury">Create a workspace to track treasury transfers.</Blank></Card>;
  if (!data) return error ? <Notice>{error}</Notice> : <Loading />;
  return <div className="op-stack">{error && <Notice>{error} Showing the last loaded state.</Notice>}<div className="op-metrics"><div><span>Spendable on-chain</span><strong><Amount raw={data.wallet.spendableRaw} /></strong><small>After balance locks and account minimum</small></div><div><span>Awaiting approval</span><strong><Amount raw={data.pendingRaw} /></strong><small>Proposed spending · still in treasury</small></div><div><span>Draft payments</span><strong><Amount raw={data.draftsRaw} /></strong><small>Unapproved · funds are not reserved</small></div></div>
    <Card className="op-card"><CardHeader className="op-card-heading"><div><CardTitle>Treasury transfers</CardTitle><CardDescription>Actual balances.Transfer events involving {shortAddress(treasury.address)}.</CardDescription></div><Badge variant="outline">{data.historyAvailable ? 'Synced' : 'Catching up'}</Badge></CardHeader>
      {data.entries.length ? <Table><TableHeader><TableRow><TableHead>Movement</TableHead><TableHead>Counterparty</TableHead><TableHead>Amount</TableHead><TableHead>Finalized block</TableHead><TableHead>Transaction</TableHead></TableRow></TableHeader><TableBody>{data.entries.map(e => <TableRow key={e.id}><TableCell><span className={'op-direction ' + e.direction}>{e.direction === 'incoming' ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}{e.direction === 'incoming' ? 'Received' : 'Paid out'}</span></TableCell><TableCell><code title={e.counterparty}>{shortAddress(e.counterparty)}</code></TableCell><TableCell><Amount raw={e.amountRaw} /></TableCell><TableCell>#{e.blockNumber.toLocaleString()}</TableCell><TableCell><code title={e.txHash}>{shortAddress(e.txHash)}</code></TableCell></TableRow>)}</TableBody></Table> : <Blank title="No transfers in the indexed window">Fund this treasury or execute a payment to see its on-chain movement.</Blank>}
      <div className="op-coverage">Indexed from #{data.coverageFromBlock.toLocaleString()} through #{data.syncedToBlock.toLocaleString()}. Latest 500 transfer events; this window may not cover the treasury’s entire history.</div>
    </Card><div className="op-two-col"><Card className="op-card"><CardHeader><CardTitle>Signer costs</CardTitle><CardDescription>Paid by signing wallets, separate from the treasury’s payment principal.</CardDescription></CardHeader><CardContent><div className="op-summary-row"><span>Recorded action fees</span><Amount raw={data.signerFeesRaw} /></div><p className="fine-print">Fees from approvals, execution, cancellation, and unlock receipts recorded by PortaFlow. Other wallet activity is excluded.</p></CardContent></Card><Card className="op-card"><CardHeader><CardTitle>Refundable deposits</CardTitle><CardDescription>Currently reserved in initiating signers’ wallets.</CardDescription></CardHeader><CardContent>{data.pendingDeposits.length ? data.pendingDeposits.map(d => <div key={d.proposalId} className="op-summary-row"><span>{d.title}<small>{shortAddress(d.depositor)}</small></span><Amount raw={d.amountRaw} /></div>) : <p className="fine-print">No pending approval deposits found.</p>}<p className="fine-print">Released by the chain when the proposal executes or is cancelled.</p></CardContent></Card></div>
  </div>;
}

export function RecipientPage({ address, block, open, onReview, onWallet, networkReady }: { address?: string; block: number; open: (id: string, round: boolean) => void; onReview: (r: PaymentReview) => void; onWallet: () => void; networkReady: boolean }) {
  const [input, setInput] = useState(address || ''), [target, setTarget] = useState(address || ''), [data, setData] = useState<RecipientPortal | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (address) { setInput(address); setTarget(address); } }, [address]);
  useEffect(() => { setData(null); setError(''); }, [target]);
  useEffect(() => { let live = true; if (target) void request<RecipientPortal>('/recipient/' + encodeURIComponent(target)).then(d => { if (live) { setData(d); setError(''); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [target, block]);
  const unlock = async () => { if (!address) return onWallet(); setBusy(true); setError(''); try { onReview({ plan: await request('/recipient/' + target + '/unlock-plan', {}), recipient: target }); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  return <div className="op-stack"><form className="op-address-search" onSubmit={async e => { e.preventDefault(); try { const { normalize } = await import('./wallet'); setTarget(normalize(input)); setError(''); } catch (e) { setError(message(e)); } }}><Input aria-label="Recipient address" className="op-monospace" required placeholder="Look up any Portaldot recipient address" value={input} onChange={e => setInput(e.target.value)} /><Button type="submit" variant="outline">Look up <ArrowRight /></Button></form>
    {error && <Notice>{error}</Notice>}{target && !data && !error && <Loading />}
    {data && <><div className="op-metrics"><div><span>Funding across workspaces</span><strong><Amount raw={data.totalFundedRaw} /></strong><small>{data.awards.length} funded payments in PortaFlow</small></div><div><span>Currently spendable</span><strong><Amount raw={data.wallet.spendableRaw} /></strong><small>Whole wallet · includes other activity</small></div><div><span>Vesting lock</span><strong><Amount raw={data.wallet.vestingLockRaw} /></strong><small>Whole wallet · native chain state</small></div></div>
      <Card className="op-card op-unlock-card"><CardContent><div><span className="eyebrow">AVAILABLE TO UNLOCK</span><div className="op-total"><Amount raw={data.wallet.eligibleUnlockRaw} /></div><p className="fine-print">Update the vesting lock across this wallet’s schedules. The signing account pays the network fee.</p></div><Button disabled={busy || !networkReady || BigInt(data.wallet.eligibleUnlockRaw) === 0n} onClick={() => void unlock()}>{busy ? <LoaderCircle className="spin" /> : <ArrowDownLeft />}{address === target ? 'Unlock my funds' : 'Unlock for recipient'}</Button></CardContent></Card>
      <Card className="op-card"><CardHeader><CardTitle>My funded contributions</CardTitle><CardDescription>Payments recorded across all PortaFlow workspaces. Schedule progress follows finalized blocks.</CardDescription></CardHeader>{data.awards.length ? <Table><TableHeader><TableRow><TableHead>Contribution / workspace</TableHead><TableHead>Funding</TableHead><TableHead>Release progress</TableHead><TableHead><span className="sr-only">Details</span></TableHead></TableRow></TableHeader><TableBody>{data.awards.map(a => {
        const remaining = vestedRemaining(BigInt(a.lockedRaw), BigInt(a.perBlockRaw), a.startBlock, block);
        const percent = BigInt(a.lockedRaw) === 0n ? 100 : Number((BigInt(a.lockedRaw) - remaining) * 100n / BigInt(a.lockedRaw));
        return <TableRow key={a.id}><TableCell><div className="op-payment-name"><strong>{a.title}</strong><small>{a.treasuryName}</small></div></TableCell><TableCell><Amount raw={a.totalRaw} /><small className="op-block">{formatAmount(a.upfrontRaw)} immediate</small></TableCell><TableCell className="op-release-cell">{a.lockedRaw === '0' ? 'Paid immediately' : <><Progress value={percent} aria-label={a.title + ' vested'} /><small>{block < a.startBlock ? (a.startBlock - block) + ' blocks until start' : percent + '% vested'} · ends #{a.endBlock.toLocaleString()}</small></>}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={'Open ' + a.title} onClick={() => open(a.roundId || a.id, Boolean(a.roundId))}><ArrowUpRight /></Button></TableCell></TableRow>;
      })}</TableBody></Table> : <Blank title="No PortaFlow payments found">This address has no funded payments recorded in PortaFlow. Wallet balances above come directly from Portaldot.</Blank>}</Card>
    </>}{!target && <Card className="op-card"><Blank title="Your contributions, in one place">Connect your recipient wallet or look up an address to see funding, live locks, and available unlocks.</Blank></Card>}
  </div>;
}

export function VerifyPage() {
  const [document, setDocument] = useState<unknown>(), [filename, setFilename] = useState(''), [result, setResult] = useState<Verification | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async (file?: File) => { setError(''); setResult(null); setDocument(undefined); setFilename(file?.name || ''); if (!file) return; try { if (file.size > 65_000) throw new Error('Receipt must be under 65 KB.'); setDocument(JSON.parse(await file.text())); } catch (e) { setError(message(e)); } };
  const verify = async () => { setBusy(true); setError(''); setResult(null); try { setResult(await request<Verification>('/verify', document)); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  return <div className="op-verifier"><Card className="op-card"><CardHeader><FileCheck2 size={25} className="op-verify-icon" /><CardTitle>Verify a payment receipt</CardTitle><CardDescription>Upload a downloaded award or round receipt. Verification reads the referenced block and transaction directly from the pinned Portaldot RPC, without looking up the award in PortaFlow’s database.</CardDescription></CardHeader><CardContent><label className="import-file"><Upload size={20} /><strong>{filename || 'Choose a PortaFlow receipt'}</strong><span>JSON · up to 65 KB · no wallet needed</span><input type="file" accept=".json,application/json" disabled={busy} onChange={e => void load(e.target.files?.[0])} /></label>{error && <Notice>{error}</Notice>}<Button className="op-full" disabled={!document || busy} onClick={() => void verify()}>{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}{busy ? 'Checking finalized chain evidence…' : 'Verify against Portaldot'}</Button><p className="fine-print op-verifier-note">Checks the derived treasury, exact payment manifest, finalized inclusion, successful atomic execution, on-chain commitment, and recipient transfer totals. This relies on the connected RPC for chain history.</p></CardContent></Card>
    {result && <Card className={'op-card op-verification-result verification-' + result.status}><CardHeader><Badge variant="outline">{result.status === 'verified' ? 'Verified on Portaldot' : result.status === 'invalid' ? 'Verification failed' : 'Could not complete verification'}</Badge><CardTitle>{result.subject}</CardTitle>{result.blockNumber && <CardDescription>Funding block #{result.blockNumber.toLocaleString()}</CardDescription>}</CardHeader><CardContent><div className="op-checks">{result.checks.map((c, i) => <div key={i}><span className={c.passed ? 'check-pass' : 'check-fail'}>{c.passed ? <Check size={15} /> : '!'}</span><div><strong>{c.label}</strong><p>{c.detail}</p></div></div>)}</div>{result.txHash && <code className="op-hash">{result.txHash}</code>}</CardContent></Card>}
  </div>;
}
