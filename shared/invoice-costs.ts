import type {Receipt} from './types.js';
import {sameAddress} from './accounts.js';

/** Gross storage deposits recorded by this payment, distinct from current held balances. */
export function invoiceRecordedCosts(receipts:Receipt[],treasury:string){
  let networkFees=0n,storageDeposits=0n;const seen=new Set<string>();let funded=false;
  for(const receipt of receipts){
    if(seen.has(receipt.txHash))continue;seen.add(receipt.txHash);
    networkFees+=BigInt(receipt.feeRaw);
    if(receipt.kind!=='funding')continue;funded=true;
    for(const event of receipt.events){
      if(event.section!=='balances'||event.method!=='TransferAndHold')continue;
      if(!Array.isArray(event.data))throw new Error('Storage deposit evidence has an unexpected shape.');
      const [reason,from,,amount]=event.data;
      if((reason as {revive?:string})?.revive!=='StorageDepositReserve'||typeof from!=='string'||!sameAddress(from,treasury))continue;
      if(typeof amount==='number'&&!Number.isSafeInteger(amount))throw new Error('Storage deposit evidence is not an exact integer.');
      if(typeof amount!=='number'&&typeof amount!=='string')throw new Error('Storage deposit evidence is missing its amount.');
      const raw=BigInt(amount);if(raw<0n)throw new Error('Storage deposit evidence is invalid.');storageDeposits+=raw;
    }
  }
  return{networkFeesRaw:networkFees.toString(),storageDepositsRaw:funded?storageDeposits.toString():undefined};
}
