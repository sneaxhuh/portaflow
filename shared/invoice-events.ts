import { decodeEventLog, type Hex } from 'viem';
import { settlementAbi } from './settlement-abi.js';
import { batchPayments, settlementBatchHash, type InvoiceBatch } from './invoices.js';
export function settlementEvents(events: any[], address: string) {
  return events.flatMap(record => {
    const event = record.event ?? record;
    if (event.section !== 'revive' || event.method !== 'ContractEmitted') return [];
    const data = event.data;
    const contract = String(data[0] ?? data.contract).toLowerCase();
    if (contract !== address.toLowerCase()) return [];
    const bytes = data[1] ?? data.data, values = data[2] ?? data.topics;
    try { return [decodeEventLog({ abi: settlementAbi, data: (bytes.toHex?.() ?? bytes) as Hex,
      topics: Array.from(values, (v: any) => v.toHex?.() ?? v) as [Hex, ...Hex[]] })]; } catch { return []; }
  });
}
export function hasInvoiceSettlement(events: any[], batch: InvoiceBatch) {
  const logs = settlementEvents(events, batch.router);
  const payments = logs.filter(log => log.eventName === 'InvoiceSettled');
  const batches = logs.filter(log => log.eventName === 'BatchSettled');
  return payments.length === batch.invoices.length && batches.length === 1
    && batchPayments(batch).every(p => payments.some(log => log.args.payer.toLowerCase() === batch.payer.toLowerCase()
      && log.args.invoiceId === p.invoiceId && log.args.termsHash === p.termsHash && log.args.recipient.toLowerCase() === p.recipient.toLowerCase()
      && log.args.token.toLowerCase() === batch.asset.token.toLowerCase() && log.args.amount === p.amount))
    && batches[0].args.payer.toLowerCase() === batch.payer.toLowerCase() && batches[0].args.token.toLowerCase() === batch.asset.token.toLowerCase()
    && batches[0].args.batchHash === settlementBatchHash(batch)
    && batches[0].args.count === BigInt(batch.invoices.length) && batches[0].args.total === batchPayments(batch).reduce((n,p)=>n+p.amount,0n);
}
