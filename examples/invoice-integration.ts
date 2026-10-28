import { ApiPromise, HttpProvider } from '@polkadot/api';
import { invoiceMessage, invoiceTermsHash, verifyInvoiceSignature, type Invoice, verifyReceipt } from '../sdk/index.js';

// A caller supplies a wallet signature. This integration never receives a key or broadcasts a payment.
export async function submitPaymentRequest(baseUrl: string, input: {
  treasuryId: string; recipient: string; number: string; title: string; amount: string; assetId?: string; dueDate: string; workUrl?: string;
}, sign: (message: string) => Promise<string>, sessionCookie: string) {
  const post = async<T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(new URL('/api'+path,baseUrl),{method:'POST',headers:{'Content-Type':'application/json',Cookie:sessionCookie},body:JSON.stringify(body)});
    if(!response.ok)throw new Error('Payment request API returned '+response.status);
    return response.json() as Promise<T>;
  };
  const prepared=await post<Invoice>('/invoices/prepare',input);
  if(prepared.termsHash!==invoiceTermsHash(prepared)||prepared.recipient!==input.recipient||prepared.treasuryId!==input.treasuryId)throw new Error('Unexpected invoice terms.');
  const signature=await sign(invoiceMessage(prepared));
  if(!verifyInvoiceSignature({...prepared,signature:signature as `0x${string}`}))throw new Error('Wallet signature did not match the invoice.');
  return post<Invoice>('/invoices',{...input,id:prepared.id,createdAt:prepared.createdAt,termsHash:prepared.termsHash,signature});
}

export async function verifyPaymentIndependently(receipt: unknown) {
  const api=await ApiPromise.create({provider:new HttpProvider('https://test-node-v3.portaldot.dev'),noInitWarn:true});
  try{return await verifyReceipt(api,receipt);}finally{await api.disconnect();}
}
