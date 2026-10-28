import { vestedRemaining, UNIT } from './money.js';
import { NETWORK, type Award, type PayoutRound, type Treasury, type ProgramReport } from './types.js';

export function programReport(treasury: Treasury, awards: Award[], rounds: PayoutRound[], finalizedBlock: number, indexedBlock: number, generatedAt = new Date().toISOString()): ProgramReport {
  if (!Number.isSafeInteger(finalizedBlock) || finalizedBlock < 1) throw new Error('Waiting for a finalized Portaldot block before reporting release progress.');
  const ownAwards = awards.filter(a => a.treasuryId === treasury.id), ownRounds = rounds.filter(r => r.treasuryId === treasury.id);
  const funded = [
    ...ownAwards.filter(a => a.status === 'funded').map(award => ({ award, round: undefined as PayoutRound | undefined })),
    ...ownRounds.filter(r => r.status === 'funded').flatMap(round => round.awards.map(award => ({ award, round }))),
  ];
  const payments: ProgramReport['payments'] = funded.map(({ award: a, round }) => ({
    id: a.id, ...(round ? { roundId: round.id, roundTitle: round.title } : {}), title: a.title, recipient: a.recipient, workUrl: a.workUrl,
    totalRaw: a.totalRaw, upfrontRaw: a.upfrontRaw, lockedRaw: a.lockedRaw,
    remainingRaw: vestedRemaining(BigInt(a.lockedRaw), BigInt(a.perBlockRaw), a.startBlock, finalizedBlock).toString(),
    startBlock: a.startBlock, endBlock: a.endBlock, fundingTx: round?.fundingTx || a.fundingTx || '', fundingBlock: round?.fundingBlock || a.fundingBlock || 0,
    receiptPath: '/api/' + (round ? 'rounds/' + round.id : 'awards/' + a.id) + '/receipt',
  }));
  const sum = (key: 'totalRaw' | 'upfrontRaw' | 'lockedRaw' | 'remainingRaw') => payments.reduce((s, a) => s + BigInt(a[key]), 0n);
  const proposals = [...ownAwards, ...ownRounds];
  return { version: 1, network: NETWORK, treasury, generatedAt, finalizedBlock, indexedBlock, historySynced: indexedBlock >= finalizedBlock,
    totals: { fundedRaw: sum('totalRaw').toString(), immediateRaw: sum('upfrontRaw').toString(), vestedRaw: sum('lockedRaw').toString(),
      remainingScheduledRaw: sum('remainingRaw').toString(), earnedByScheduleRaw: (sum('lockedRaw') - sum('remainingRaw')).toString(),
      paymentCount: payments.length, recipientCount: new Set(payments.map(p => p.recipient)).size,
      fundingTransactions: new Set(payments.filter(p => p.fundingTx).map(p => p.fundingTx)).size,
      pendingProposals: proposals.filter(p => p.status === 'awaiting_approval').length,
      draftProposals: proposals.filter(p => p.status === 'draft').length }, payments };
}

// Plain decimal amounts for spreadsheets, without grouping or precision loss.
const decimal = (raw: string) => { const n = BigInt(raw); return (n / UNIT).toString() + '.' + (n % UNIT).toString().padStart(14, '0'); };
const cell = (value: unknown) => {
  let text = String(value ?? '');
  // Quoting alone does not prevent spreadsheets from evaluating formulas.
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function programReportCsv(report: ProgramReport): string {
  const headers = ['treasury', 'treasury_address', 'payment_id', 'round_id', 'contribution', 'recipient', 'total_tPOT', 'immediate_tPOT', 'vested_tPOT', 'scheduled_remainder_tPOT', 'start_block', 'end_block', 'funding_block', 'funding_transaction', 'work_reference', 'report_finalized_block', 'index_through_block'];
  const rows = report.payments.map(p => [report.treasury.name, report.treasury.address, p.id, p.roundId || '', p.title, p.recipient,
    decimal(p.totalRaw), decimal(p.upfrontRaw), decimal(p.lockedRaw), decimal(p.remainingRaw), p.startBlock, p.endBlock, p.fundingBlock,
    p.fundingTx, p.workUrl, report.finalizedBlock, report.indexedBlock]);
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
