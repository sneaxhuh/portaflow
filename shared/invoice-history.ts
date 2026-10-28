import type { ApiPromise } from '@polkadot/api';
import type { Address, Hex } from 'viem';
import { settlementEvents } from './invoice-events.js';
import { NETWORK } from './types.js';
export type InvoiceSettlementEntry = { invoiceId:Hex;termsHash:Hex;payer:Address;recipient:Address;token:Address;amount:string;blockNumber:number;blockHash:string;txHash:string;extrinsicIndex:number };

/** Read public settlement facts from finalized native blocks, without a PortaFlow database. */
export async function recoverInvoiceSettlements(api:ApiPromise,input:{router:Address;payer:Address;fromBlock:number;limit?:number}) {
  if(api.genesisHash.toHex()!==NETWORK.genesis)throw new Error('Connect to the pinned Portaldot testnet.');
  if(!Number.isSafeInteger(input.fromBlock)||input.fromBlock<1||!Number.isSafeInteger(input.limit??48)||(input.limit??48)<1||(input.limit??48)>96)throw new Error('Choose a positive start block and a window of 1–96 blocks.');
  const head=await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead()),end=Math.min(head.number.toNumber(),input.fromBlock+(input.limit??48)-1);
  const entries:InvoiceSettlementEntry[]=[];
  for(let start=input.fromBlock;start<=end;start+=8){
    const windows=await Promise.all(Array.from({length:Math.min(8,end-start+1)},async(_,n)=>{
      const number=start+n,hash=await api.rpc.chain.getBlockHash(number),at=await api.at(hash),records:any=await at.query.system.events();
      const candidates:any[]=records.filter((r:any)=>r.phase.isApplyExtrinsic&&settlementEvents([r],input.router).some(l=>l.eventName==='InvoiceSettled'&&l.args.payer.toLowerCase()===input.payer.toLowerCase()));
      if(!candidates.length)return [];
      const block=await api.rpc.chain.getBlock(hash);
      return candidates.flatMap(record=>settlementEvents([record],input.router).flatMap(log=>log.eventName==='InvoiceSettled'&&log.args.payer.toLowerCase()===input.payer.toLowerCase()?[{
        ...log.args,amount:log.args.amount.toString(),blockNumber:number,blockHash:hash.toHex(),txHash:block.block.extrinsics[record.phase.asApplyExtrinsic.toNumber()].hash.toHex(),extrinsicIndex:record.phase.asApplyExtrinsic.toNumber(),
      }]:[]));
    }));entries.push(...windows.flat());
  }
  return {entries,finalizedBlock:head.number.toNumber(),scannedFrom:input.fromBlock,scannedTo:end,nextBlock:Math.max(input.fromBlock,end+1)};
}
