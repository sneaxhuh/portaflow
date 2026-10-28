import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex, decodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { stringToU8a, stringToHex, u8aToHex } from '@polkadot/util';
import { encodeFunctionData, encodeAbiParameters, parseAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { normalizeAddress, treasuryIdentity } from './accounts.js';
import { canonical, MAX_BALANCE } from './money.js';
import { NETWORK, type PendingApproval, type Receipt, type Treasury, type TransactionPlan } from './types.js';
import { settlementAbi, invoiceTokenAbi } from './settlement-abi.js';

export type PaymentAsset = { kind: 'native' | 'asset'; id?: string; symbol: string; decimals: number; token: Address };
export const NATIVE_ASSET: PaymentAsset = { kind: 'native', symbol: NETWORK.symbol, decimals: NETWORK.decimals, token: zeroAddress };
export type Invoice = {
  id: Hex; number: string; title: string; treasuryId: string; treasuryAddress: string; issuer: string; recipient: string;
  asset: PaymentAsset; amountRaw: string; workUrl: string; dueDate: string; createdAt: string; termsHash: Hex; signature: Hex;
  status: 'submitted' | 'declined' | 'awaiting_approval' | 'paid'; batchId?: string; declineReason?: string;
};
export type InvoiceInput = { number: string; title: string; treasuryId: string; recipient: string; assetId?: string; amount: string; workUrl?: string; dueDate: string };
export type ContractPayment = { invoiceId: Hex; termsHash: Hex; recipient: Address; amount: bigint };
export type InvoiceBatch = {
  id: string; title: string; treasuryId: string; invoices: Invoice[]; asset: PaymentAsset; totalRaw: string; createdAt: string; createdBy: string;
  status: 'draft' | 'awaiting_approval' | 'paid' | 'cancelled' | 'failed'; router: Address; runtimeCodeHash: Hex;
  payer: Address; recipients: Address[]; specVersion: number; callHex: string; callHash: string;
  weight: { refTime: string; proofSize: string }; storageDepositRaw: string;
  approvalStorageDepositRaw?: string;
  fundingTx?: string; fundingBlock?: number; failure?: string;
};
export type SettlementDeploymentReference = {txHash:string;blockHash:string;treasuryId:string;address?:Address;blockNumber?:number};
export type SettlementStatus = { configured: boolean; verified: boolean; address?: Address; runtimeCodeHash: Hex; error?: string; pendingDeployment?:SettlementDeploymentReference; };
export type InvoiceInbox = { invoices: Invoice[]; batches: InvoiceBatch[]; settlement: SettlementStatus; };
export type InvoiceBatchDetail = { batch: InvoiceBatch; treasury: Treasury; pending: PendingApproval | null; receipts: Receipt[]; reviewRequired: boolean };
export type InvoiceReceipt = { application: 'PortaFlow'; version: 3; network: typeof NETWORK; treasury: Treasury; batch: InvoiceBatch; transactions: Receipt[]; };
export type InvoiceReview = { plan: TransactionPlan; invoiceBatch: InvoiceBatch; treasury: Treasury };

const key = (address: string) => u8aToHex(decodeAddress(normalizeAddress(address)));
const digest = (value: unknown) => blake2AsHex(stringToU8a(canonical(value))) as Hex;
export function invoiceId(treasury: string, issuer: string, number: string): Hex {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,39}$/.test(number)) throw new Error('Use an invoice number of 1–40 letters, numbers, dots, slashes, underscores or hyphens.');
  return digest({ version: 1, genesis: NETWORK.genesis, treasury: key(treasury), issuer: key(issuer), number: number.toUpperCase() });
}
export function invoiceTerms(invoice: Invoice) {
  return { version: 1, genesis: NETWORK.genesis, id: invoice.id, number: invoice.number, title: invoice.title,
    treasury: key(invoice.treasuryAddress), issuer: key(invoice.issuer), recipient: key(invoice.recipient), asset: invoice.asset,
    amountRaw: invoice.amountRaw, workUrl: invoice.workUrl, dueDate: invoice.dueDate, createdAt: invoice.createdAt };
}
export const invoiceTermsHash = (invoice: Invoice) => digest(invoiceTerms(invoice));
export const invoiceMessage = (invoice: Invoice) => ['PortaFlow payment request', 'Network: ' + NETWORK.genesis,
  'Invoice: ' + invoice.number, 'Treasury: ' + invoice.treasuryAddress, 'Recipient: ' + invoice.recipient,
  'Amount: ' + formatAssetAmount(invoice.amountRaw, invoice.asset.decimals) + ' ' + invoice.asset.symbol,
  'Terms hash: ' + invoiceTermsHash(invoice), '', 'This requests payment. It does not authorize spending from your wallet.'].join('\n');
export function verifyInvoiceSignature(invoice: Invoice) {
  try { return invoice.id === invoiceId(invoice.treasuryAddress, invoice.issuer, invoice.number)
    && invoice.termsHash === invoiceTermsHash(invoice) && normalizeAddress(invoice.issuer) === normalizeAddress(invoice.recipient)
    && signatureVerify(invoiceMessage(invoice), invoice.signature, invoice.issuer).isValid; } catch { return false; }
}
export function parseAssetAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Asset decimals must be between 0 and 18.');
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})(\.\d+)?$/.test(value)) throw new Error('Enter a positive decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('This asset supports up to ' + decimals + ' decimal places.');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n || amount > MAX_BALANCE) throw new Error('Amount is outside the supported range.');
  return amount;
}
export function formatAssetAmount(raw: string, decimals: number) {
  const value = BigInt(raw), unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / unit).toString() + (decimals && fraction ? '.' + fraction : '');
}
export const sameAsset = (a: PaymentAsset, b: PaymentAsset) => canonical(a) === canonical(b);
export const invoiceStorageLimit = (batch: InvoiceBatch) => (BigInt(batch.storageDepositRaw)+(batch.asset.kind==='asset'?2n*BigInt(batch.approvalStorageDepositRaw??batch.storageDepositRaw):0n)).toString();
export function batchPayments(batch: InvoiceBatch): ContractPayment[] {
  if (batch.invoices.length < 1 || batch.invoices.length > 25 || batch.recipients.length !== batch.invoices.length) throw new Error('Use 1–25 invoice payments.');
  if (new Set(batch.invoices.map(i => i.id)).size !== batch.invoices.length) throw new Error('An invoice appears twice in this batch.');
  const total = batch.invoices.reduce((sum, invoice) => {
    if (!verifyInvoiceSignature(invoice) || invoice.treasuryId !== batch.treasuryId || !sameAsset(invoice.asset, batch.asset)
      || !/^\d+$/.test(invoice.amountRaw) || BigInt(invoice.amountRaw) <= 0n || BigInt(invoice.amountRaw) > MAX_BALANCE) throw new Error('Invoice terms or contributor signature are invalid.');
    return sum + BigInt(invoice.amountRaw);
  }, 0n);
  if (total.toString() !== batch.totalRaw || total > MAX_BALANCE) throw new Error('Invoice batch total is invalid.');
  return batch.invoices.map((invoice, i) => ({ invoiceId: invoice.id, termsHash: invoice.termsHash, recipient: batch.recipients[i],
    amount: BigInt(invoice.amountRaw) * (batch.asset.kind === 'native' ? 10_000n : 1n) }));
}
export const settlementBatchHash = (batch:InvoiceBatch) => keccak256(encodeAbiParameters(
  parseAbiParameters('address token, (bytes32 invoiceId, bytes32 termsHash, address recipient, uint256 amount)[] payments'),
  [batch.asset.token,batchPayments(batch)],
));
export function invoiceBatchCalls(api: ApiPromise, batch: InvoiceBatch, treasury: Treasury) {
  const identity = treasuryIdentity(treasury.signatories, treasury.threshold);
  if (identity.address !== treasury.address || batch.treasuryId !== treasury.id
    || batch.invoices.some(i => i.treasuryAddress !== treasury.address)) throw new Error('Invoice treasury does not match the signing policy.');
  const data = encodeFunctionData({ abi: settlementAbi, functionName: 'settle', args: [batch.asset.token, batchPayments(batch)] });
  const call = (to: Address, value: string, input: Hex, storage=batch.storageDepositRaw) => api.tx.revive.call(to, value, batch.weight, storage, input);
  const calls = [];
  if (batch.asset.kind === 'asset') {
    calls.push(call(batch.asset.token, '0', encodeFunctionData({ abi: invoiceTokenAbi, functionName: 'approve', args: [batch.router, 0n] }),batch.approvalStorageDepositRaw??batch.storageDepositRaw));
    calls.push(call(batch.asset.token, '0', encodeFunctionData({ abi: invoiceTokenAbi, functionName: 'approve', args: [batch.router, BigInt(batch.totalRaw)] }),batch.approvalStorageDepositRaw??batch.storageDepositRaw));
  }
  calls.push(call(batch.router, batch.asset.kind === 'native' ? batch.totalRaw : '0', data));
  // Retrying a cancelled unpaid batch must create a distinct multisig proposal,
  // while the invoice IDs still retain their on-chain replay protection.
  calls.push(api.tx.system.remarkWithEvent(stringToHex(JSON.stringify({app:'PortaFlow',version:3,invoiceBatchId:batch.id}))));
  return api.tx.utility.batchAll(calls);
}
