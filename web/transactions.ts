import {request} from './api';
import {rememberReceipt} from './receipts';
export type PendingTransaction={txHash:string;callHash:string;signer:string;kind:string;treasuryId?:string;fromBlock:number;nextBlock:number;createdAt:string};
const KEY='portaflow-pending-transactions';
export class PendingConfirmationError extends Error {constructor(public txHash:string){super('Confirmation pending. The signed transaction reference is saved below. Check its status before signing again.');this.name='PendingConfirmationError';}}
export function pendingTransactions():PendingTransaction[]{
  try{const rows=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(rows)?rows.filter(r=>/^0x[0-9a-f]{64}$/i.test(r.txHash)&&/^0x[0-9a-f]{64}$/i.test(r.callHash)&&typeof r.signer==='string'&&typeof r.kind==='string'&&Number.isSafeInteger(r.fromBlock)&&Number.isSafeInteger(r.nextBlock)):[];}catch{return [];}
}
function save(rows:PendingTransaction[]){localStorage.setItem(KEY,JSON.stringify(rows));window.dispatchEvent(new Event('portaflow-pending-changed'));}
export function rememberPending(tx:PendingTransaction){const rows=pendingTransactions().filter(p=>p.txHash!==tx.txHash);if(rows.length>=25)throw new Error('Resolve saved transactions before submitting more. Nothing new was submitted.');save([...rows,tx]);}
export function forgetPending(txHash:string){save(pendingTransactions().filter(tx=>tx.txHash!==txHash));}
export function pendingFor(callHash:string,signer:string,kind?:string){return pendingTransactions().find(tx=>(tx.callHash===callHash&&tx.signer===signer)||(kind==='settlement deployment'&&tx.kind===kind));}
export async function reconcileTransaction(tx:PendingTransaction){
  const result=await request<{status:'pending'|'finalized';nextBlock:number;blockHash?:string;success?:boolean}>('/transactions/reconcile',tx);
  if(result.status==='finalized'&&result.blockHash){
    rememberReceipt({txHash:tx.txHash,blockHash:result.blockHash});forgetPending(tx.txHash);
    if(result.success&&tx.kind==='settlement deployment'&&tx.treasuryId){
      const reference={txHash:tx.txHash,blockHash:result.blockHash,treasuryId:tx.treasuryId};
      localStorage.setItem('portaflow-settlement-registration',JSON.stringify(reference));
      await request('/settlement/register',reference);localStorage.removeItem('portaflow-settlement-registration');
    }
  }else if(pendingTransactions().some(p=>p.txHash===tx.txHash))rememberPending({...tx,nextBlock:result.nextBlock});
  return result;
}
