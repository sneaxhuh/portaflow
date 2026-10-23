import { request } from './api';

const RECEIPT_QUEUE = 'portaflow-finalized-transactions';
type FinalizedTransaction = { txHash: string; blockHash: string };
function queuedReceipts(): FinalizedTransaction[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECEIPT_QUEUE) || '[]');
    return Array.isArray(value) ? value.filter(tx => /^0x[0-9a-f]{64}$/i.test(tx?.txHash) && /^0x[0-9a-f]{64}$/i.test(tx?.blockHash)).slice(-25) : [];
  } catch { return []; }
}
export function rememberReceipt(tx: FinalizedTransaction) {
  try { localStorage.setItem(RECEIPT_QUEUE, JSON.stringify([...queuedReceipts().filter(row => row.txHash !== tx.txHash), tx].slice(-25))); } catch { /* Browser storage may be disabled. */ }
}
let receiptSync: Promise<void> | undefined;
export function syncFinalizedReceipts(): Promise<void> {
  if (receiptSync) return receiptSync;
  const transactions = queuedReceipts().slice(0, 5);
  if (!transactions.length) return Promise.resolve();
  receiptSync = (async () => {
    const result = await request<{ accepted: string[] }>('/sync', { transactions });
    try { localStorage.setItem(RECEIPT_QUEUE, JSON.stringify(queuedReceipts().filter(tx => !result.accepted.includes(tx.txHash)))); } catch { /* Replaying verified receipts is safe. */ }
  })().finally(() => { receiptSync = undefined; });
  return receiptSync;
}
