import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAddress} from '@polkadot/util-crypto';
import {invoiceRecordedCosts} from '../shared/invoice-costs';
import type {Receipt} from '../shared/types';
const treasury=encodeAddress(new Uint8Array(32).fill(1),42),other=encodeAddress(new Uint8Array(32).fill(2),42);
test('cost reporting separates signer fees from treasury storage deposits and deduplicates receipt replay',()=>{
 const receipt={txHash:'funded',kind:'funding',feeRaw:'5641497363853',events:[
  {section:'balances',method:'Transfer',data:[treasury,other,'100000000000000']},
  {section:'balances',method:'TransferAndHold',data:[{revive:'StorageDepositReserve'},treasury,other,'384150000000000']},
  {section:'balances',method:'TransferAndHold',data:[{revive:'CodeUploadDepositReserve'},treasury,other,'999']},
  {section:'balances',method:'TransferAndHold',data:[{revive:'StorageDepositReserve'},other,treasury,'999']},
 ]} as Receipt;
 const costs=invoiceRecordedCosts([receipt,receipt,{...receipt,txHash:'approval',kind:'approval',feeRaw:'2180493732034'}],treasury);
 assert.equal(costs.storageDepositsRaw,'384150000000000');assert.equal(costs.networkFeesRaw,'7821991095887');
 assert.equal(invoiceRecordedCosts([],treasury).storageDepositsRaw,undefined);
});
