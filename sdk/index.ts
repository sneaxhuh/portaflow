import type { ApiPromise } from '@polkadot/api';
import { treasuryIdentity, normalizeAddress } from '../shared/accounts.js';
import { roundFundingCall, roundTermsHash } from '../shared/calls.js';
import { parseAmount, schedule } from '../shared/money.js';
import { NETWORK, type Award, type PayoutRound, type Treasury } from '../shared/types.js';

export { NETWORK } from '../shared/types.js';
export type { Award, PayoutRound, Treasury, TransactionPlan, ReceiptBundle, Verification, ProgramReport } from '../shared/types.js';
export { normalizeAddress, sameAddress, treasuryIdentity as deriveTreasury } from '../shared/accounts.js';
export { parseAmount, formatAmount, schedule, vestedRemaining } from '../shared/money.js';
export { roundManifest, roundTermsHash, roundFundingCall as buildRoundCall, awardTermsHash, fundingCall as buildAwardCall } from '../shared/calls.js';
export { validatePlan as validateTransactionPlan, type PlanContext } from '../shared/validation.js';
export { verifyReceipt } from '../shared/verify.js';
export { programReport as createProgramReport, programReportCsv } from '../shared/report.js';
export { invoiceId, invoiceTermsHash, invoiceMessage, verifyInvoiceSignature, parseAssetAmount, formatAssetAmount, batchPayments, settlementBatchHash, invoiceBatchCalls as buildInvoiceBatchCall, NATIVE_ASSET } from '../shared/invoices.js';
export type { Invoice, InvoiceInput, PaymentAsset, InvoiceBatch, InvoiceReceipt, InvoiceBatchDetail } from '../shared/invoices.js';
export { verifyInvoiceReceipt } from '../shared/invoice-verify.js';
export { recoverInvoiceSettlements, type InvoiceSettlementEntry } from '../shared/invoice-history.js';

export type GrantPayment = { id: string; title: string; recipient: string; amount: string; upfront: string; durationBlocks?: number; workUrl?: string };
export type RoundInput = { id: string; title: string; treasury: Treasury; createdBy: string; createdAt: string; finalizedBlock: number; startBlock: number; payments: GrantPayment[] };

/** Build a reviewable unsigned call using the caller's verified Portaldot API. Never signs or broadcasts. */
export function preparePayoutRound(api: ApiPromise, input: RoundInput): PayoutRound {
  if (api.genesisHash.toHex() !== NETWORK.genesis) throw new Error('Connect to the pinned Portaldot V3 testnet.');
  const identity = treasuryIdentity(input.treasury.signatories, input.treasury.threshold);
  if (identity.address !== input.treasury.address || identity.signatories.some((s, i) => s !== input.treasury.signatories[i])) throw new Error('Treasury policy does not match its address.');
  const creator = normalizeAddress(input.createdBy);
  if (!identity.signatories.includes(creator)) throw new Error('The author must be a treasury signer.');
  const text = (value: string, label: string, max = 100) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(label + ' is required.');
    return value.trim();
  };
  if (!Number.isSafeInteger(input.finalizedBlock) || input.finalizedBlock < 1 || input.finalizedBlock > 0xffff_ffff) throw new Error('Provide a finalized Portaldot block.');
  if (!Number.isSafeInteger(input.startBlock) || input.startBlock <= input.finalizedBlock || input.startBlock > 0xffff_ffff) throw new Error('The release start must follow the finalized block.');
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error('Provide a valid creation timestamp.');
  if (!Array.isArray(input.payments) || input.payments.length < 1 || input.payments.length > 25) throw new Error('Use between 1 and 25 payments.');
  const ids = new Set<string>();
  const awards: Award[] = input.payments.map(p => {
    const id = text(p.id, 'Payment ID');
    if (ids.has(id)) throw new Error('Payment IDs must be unique.');
    ids.add(id);
    const recipient = normalizeAddress(p.recipient);
    if (recipient === input.treasury.address) throw new Error('A treasury cannot pay itself.');
    const total = parseAmount(p.amount), upfront = p.upfront === '0' ? 0n : parseAmount(p.upfront), locked = total - upfront;
    if (locked < 0n) throw new Error('Immediate amount exceeds total payment.');
    if (locked > 0n && locked < BigInt(api.consts.vesting.minVestedTransfer.toString())) throw new Error('Vested payment is below the native minimum.');
    let workUrl = p.workUrl?.trim() || '';
    if (workUrl) { const url = new URL(workUrl); if (url.protocol !== 'https:' || workUrl.length > 500) throw new Error('Use an HTTPS work reference.'); workUrl = url.href; }
    return { id, treasuryId: input.treasury.id, title: text(p.title, 'Contribution'), recipient, workUrl,
      totalRaw: total.toString(), upfrontRaw: upfront.toString(), lockedRaw: locked.toString(), startBlock: locked ? input.startBlock : 0,
      ...(locked ? schedule(locked, p.durationBlocks ?? 10, input.startBlock) : { perBlockRaw: '0', durationBlocks: 0, endBlock: 0 }),
      createdAt: input.createdAt, createdBy: creator, createdBlock: input.finalizedBlock, status: 'draft' };
  });
  const sum = (field: 'totalRaw' | 'upfrontRaw' | 'lockedRaw') => awards.reduce((s, a) => s + BigInt(a[field]), 0n).toString();
  const round: PayoutRound = { id: text(input.id, 'Round ID'), title: text(input.title, 'Round title'), treasuryId: input.treasury.id,
    createdBy: creator, createdAt: input.createdAt, createdBlock: input.finalizedBlock, preparedBlock: input.finalizedBlock,
    startDelayBlocks: input.startBlock - input.finalizedBlock, awards, totalRaw: sum('totalRaw'), upfrontRaw: sum('upfrontRaw'), lockedRaw: sum('lockedRaw'),
    status: 'draft', specVersion: api.runtimeVersion.specVersion.toNumber() };
  const call = roundFundingCall(api, round, input.treasury);
  if (call.method.encodedLength > 48_000) throw new Error('The encoded payout round exceeds 48 KB.');
  return { ...round, callHex: call.method.toHex(), callHash: call.method.hash.toHex(), termsHash: roundTermsHash(round, input.treasury) };
}
