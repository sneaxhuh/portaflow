import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Layers3 } from 'lucide-react';
import type { PayoutRound } from '../shared/types';
import { formatAmount } from '../shared/money';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';

export function Amount({ raw = '0' }: { raw?: string }) { return <span className="op-money" title={formatAmount(raw, 14) + ' tPOT'}>{formatAmount(raw)} <small>tPOT</small></span>; }
function Blank({ title, children }: { title: string; children: ReactNode }) { return <div className="op-empty"><Layers3 size={24} /><h3>{title}</h3><p>{children}</p></div>; }
export function RoundStatus({ round }: { round: PayoutRound }) { return <Badge variant="outline" className={'op-status status-' + round.status}>{round.status === 'funded' ? 'Paid on-chain' : round.status === 'awaiting_approval' ? 'Needs approval' : round.status[0].toUpperCase() + round.status.slice(1)}</Badge>; }
export function RoundList({ rounds, open, compact = false }: { rounds: PayoutRound[]; open: (id: string) => void; compact?: boolean }) {
  const [filter, setFilter] = useState('all');
  const rows = rounds.filter(r => filter === 'all' || r.status === filter).slice(0, compact ? 4 : 1000);
  return <Card className="op-card"><CardHeader className="op-card-heading"><div><CardTitle>Payout rounds</CardTitle><CardDescription>Several payments. One shared approval.</CardDescription></div><Badge variant="secondary">{rounds.length} rounds</Badge></CardHeader>
    {!compact && <Tabs value={filter} onValueChange={setFilter} className="op-filter"><TabsList><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="awaiting_approval">Needs approval</TabsTrigger><TabsTrigger value="funded">Paid</TabsTrigger></TabsList></Tabs>}
    {rows.length ? <Table><TableHeader><TableRow><TableHead>Round</TableHead><TableHead>Payments</TableHead><TableHead>Total</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Open round</span></TableHead></TableRow></TableHeader><TableBody>{rows.map(r => <TableRow key={r.id}><TableCell><button className="op-row-title" onClick={() => open(r.id)}>{r.title}<small>{new Date(r.createdAt).toLocaleDateString()} · {new Set(r.awards.map(a => a.recipient)).size} recipients</small></button></TableCell><TableCell>{r.awards.length}</TableCell><TableCell><Amount raw={r.totalRaw} /></TableCell><TableCell><RoundStatus round={r} /></TableCell><TableCell><Button size="icon-sm" variant="ghost" aria-label={'Open ' + r.title} onClick={() => open(r.id)}><ArrowUpRight /></Button></TableCell></TableRow>)}</TableBody></Table> : <Blank title={filter === 'all' ? 'Pay your contributors together' : 'No rounds with this status'}>Add payments manually or import a CSV. Your signers approve the complete round.</Blank>}
  </Card>;
}
