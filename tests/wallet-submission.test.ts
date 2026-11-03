import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiPromise} from '@polkadot/api';
import {TypeRegistry,Metadata} from '@polkadot/types';
import {decorateExtrinsics} from '@polkadot/types/metadata/decorate';
import metadataHex from '@polkadot/types-support/metadata/static-substrate';
import {Keyring} from '@polkadot/keyring';
import {cryptoWaitReady} from '@polkadot/util-crypto';
import {NETWORK,type Treasury} from '../shared/types';
import {treasuryIdentity} from '../shared/accounts';
import {signTransaction} from '../web/wallet';
import {pendingTransactions,reconcileTransaction,PendingConfirmationError} from '../web/transactions';

test('wallet submission persists its signed hash before send, never resubmits on a lost response, and blocks another signature until reconciled',async()=>{
 await cryptoWaitReady();const keyring=new Keyring({type:'sr25519',ss58Format:42}),one=keyring.addFromUri('//Alice'),two=keyring.addFromUri('//Bob');
 const registry=new TypeRegistry(),metadata=new Metadata(registry,metadataHex);registry.setMetadata(metadata);
 const treasury:Treasury={id:'submission-test',name:'Test',...treasuryIdentity([one.address,two.address],2),threshold:2,creator:one.address,createdAt:new Date().toISOString()};
 let signatures=0,submissions=0,failSend=true;
 const tx:any=(method:any)=>{
  const extrinsic:any=registry.createType('Extrinsic',{method});
  extrinsic.signAsync=async()=>{signatures++;extrinsic.sign(one,{genesisHash:NETWORK.genesis,blockHash:NETWORK.genesis,nonce:0,runtimeVersion:{specVersion:1,transactionVersion:1}});return extrinsic;};
  extrinsic.send=async(callback:any)=>{
   submissions++;assert.equal(pendingTransactions()[0].txHash,extrinsic.hash.toHex());
   if(failSend)throw new Error('503 connection lost after submission');
   callback({txHash:extrinsic.hash,status:{isFinalized:true,asFinalized:{toHex:()=> '0x'+'3'.repeat(64)}},events:[{event:{section:'balances',method:'Transfer'}}]});return()=>{};
  };return extrinsic;
 };
 const factories=decorateExtrinsics(registry,registry.metadata,metadata.version);
 for(const [section,methods]of Object.entries(factories))tx[section]=Object.fromEntries(Object.entries(methods).map(([name,f])=>[name,(...args:unknown[])=>tx(f(...args))]));
 const api:any={tx,registry,createType:registry.createType.bind(registry),genesisHash:{toHex:()=>NETWORK.genesis},runtimeVersion:{specVersion:{toNumber:()=>1}},rpc:{chain:{getFinalizedHead:async()=>NETWORK.genesis,getHeader:async()=>({number:{toNumber:()=>42}})}}};
 const descriptors=new Map(['window','localStorage'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),values=new Map<string,string>([['portaflow-wallet-source','submission-test']]);
 const windowMock=Object.assign(new EventTarget(),{injectedWeb3:{'submission-test':{enable:async()=>({accounts:{get:async()=>[{address:one.address}]},signer:{}})}}});
 Object.defineProperty(globalThis,'window',{configurable:true,value:windowMock});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v)}});
 const originalCreate=ApiPromise.create,originalFetch=globalThis.fetch;
 ApiPromise.create=(async(options:any)=>{await options.provider.disconnect();return api;}) as typeof ApiPromise.create;
 const plan={callHex:tx.balances.transferKeepAlive(treasury.address,'100').method.toHex(),signer:one.address,genesis:NETWORK.genesis,specVersion:1,kind:'treasury funding',feeRaw:'1',depositRaw:'0'};
 try{
  await assert.rejects(()=>signTransaction(plan,{treasury,amountRaw:'100'},()=>{}),PendingConfirmationError);
  assert.equal(signatures,1);assert.equal(submissions,1);assert.equal(pendingTransactions().length,1);
  await assert.rejects(()=>signTransaction(plan,{treasury,amountRaw:'100'},()=>{}),/Confirmation pending/);
  assert.equal(signatures,1);assert.equal(submissions,1);
  globalThis.fetch=async()=>Response.json({status:'finalized',success:true,nextBlock:44,blockHash:'0x'+'3'.repeat(64)});
  await reconcileTransaction(pendingTransactions()[0]);assert.equal(pendingTransactions().length,0);
  failSend=false;await signTransaction(plan,{treasury,amountRaw:'100'},()=>{});
  assert.equal(signatures,2);assert.equal(submissions,2);assert.equal(pendingTransactions().length,0);
 }finally{ApiPromise.create=originalCreate;globalThis.fetch=originalFetch;for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
