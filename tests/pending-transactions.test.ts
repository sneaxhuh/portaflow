import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberPending,pendingTransactions,pendingFor,reconcileTransaction} from '../web/transactions';
test('saved submission survives uncertain responses; finalized reconciliation recovers its receipt and releases the signing guard',async()=>{
 const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldFetch=globalThis.fetch;
 const values=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v)}});
 Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
 const tx={txHash:'0x'+'1'.repeat(64),callHash:'0x'+'2'.repeat(64),signer:'signer',kind:'funding',fromBlock:42,nextBlock:42,createdAt:new Date().toISOString()};let calls=0;
 try{
  rememberPending(tx);assert.equal(pendingTransactions()[0].txHash,tx.txHash);assert.ok(pendingFor(tx.callHash,tx.signer));
  globalThis.fetch=async()=>{calls++;throw new Error('503');};
  await assert.rejects(()=>reconcileTransaction(tx),/503/);assert.equal(calls,1);assert.equal(pendingTransactions()[0].nextBlock,42);
  globalThis.fetch=async()=>Response.json({status:'pending',nextBlock:46});await reconcileTransaction(tx);
  assert.equal(pendingTransactions()[0].nextBlock,46);assert.ok(pendingFor(tx.callHash,tx.signer));
  globalThis.fetch=async()=>Response.json({status:'finalized',nextBlock:47,blockHash:'0x'+'3'.repeat(64),success:true});
  await reconcileTransaction(pendingTransactions()[0]);assert.equal(pendingFor(tx.callHash,tx.signer),undefined);
  assert.equal(JSON.parse(values.get('portaflow-finalized-transactions')!)[0].txHash,tx.txHash);
  for(let n=1;n<=25;n++)rememberPending({...tx,txHash:'0x'+n.toString(16).padStart(64,'0')});
  await assert.rejects(async()=>rememberPending({...tx,txHash:'0x'+'f'.repeat(64)}),/Resolve saved transactions/);
  assert.equal(pendingTransactions().length,25);assert.equal(pendingTransactions()[0].txHash,'0x'+'1'.padStart(64,'0'));
 }finally{globalThis.fetch=oldFetch;if(oldStorage)Object.defineProperty(globalThis,'localStorage',oldStorage);else Reflect.deleteProperty(globalThis,'localStorage');if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');}
});
