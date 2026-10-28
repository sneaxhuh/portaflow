import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TypeRegistry,Metadata} from '@polkadot/types';
import {decorateExtrinsics} from '@polkadot/types/metadata/decorate';
import metadataHex from '@polkadot/types-support/metadata/static-substrate';
import {cryptoWaitReady} from '@polkadot/util-crypto';
import {Keyring} from '@polkadot/keyring';
import {u8aToHex,compactAddLength,hexToU8a} from '@polkadot/util';
import {encodeAbiParameters,encodeEventTopics,zeroHash,type Hex} from 'viem';
import type {ApiPromise} from '@polkadot/api';
import {NETWORK,type Treasury} from '../shared/types';
import {treasuryIdentity} from '../shared/accounts';
import {invoiceId,invoiceTermsHash,invoiceMessage,NATIVE_ASSET,invoiceBatchCalls,settlementBatchHash,type Invoice,type InvoiceBatch,type InvoiceReceipt} from '../shared/invoices';
import {settlementAbi} from '../shared/settlement-abi';
import {verifyReceipt} from '../shared/verify';
import {recoverInvoiceSettlements} from '../shared/invoice-history';
import {validatePlan} from '../shared/validation';
import {Store} from '../server/store';
import {Chain} from '../server/chain';
import {InvoiceChain,reviveCallReverted} from '../server/invoice-chain';

test('Revive simulation recognizes runtime struct flags as well as numeric flags',()=>{
 const registry=new TypeRegistry();registry.register({ReturnFlags:{bits:'u32'}});
 assert.equal(reviveCallReverted(registry.createType('u32',1)),true);
 assert.equal(reviveCallReverted(registry.createType('u32',0)),false);
 assert.equal(reviveCallReverted(registry.createType('u32',3)),true);
 assert.equal(reviveCallReverted(registry.createType('ReturnFlags',{bits:1})),true);
 assert.equal(reviveCallReverted(registry.createType('ReturnFlags',{bits:0})),false);
});

await cryptoWaitReady();const keys=new Keyring({type:'sr25519',ss58Format:42}),one=keys.addFromUri('//Alice'),two=keys.addFromUri('//Bob'),recipient=keys.addFromUri('//Charlie'),routerAccount=keys.addFromUri('//Dave');
const artifact=JSON.parse(readFileSync('contracts/artifacts/InvoiceSettlement.json','utf8'));
function fixture(){
 const treasury:Treasury={id:'proof',name:'Proof',...treasuryIdentity([one.address,two.address],2),threshold:2,creator:one.address,createdAt:'2026-10-26T00:00:00Z'};
 const invoice:Invoice={id:invoiceId(treasury.address,recipient.address,'INV-1'),number:'INV-1',title:'Delivered work',treasuryId:treasury.id,treasuryAddress:treasury.address,issuer:recipient.address,recipient:recipient.address,asset:{...NATIVE_ASSET},amountRaw:'1000000000000000',workUrl:'',dueDate:'2026-11-06',createdAt:treasury.createdAt,termsHash:zeroHash,signature:'0x',status:'submitted'};
 invoice.termsHash=invoiceTermsHash(invoice);invoice.signature=u8aToHex(recipient.sign(invoiceMessage(invoice))) as Hex;
 const registry=new TypeRegistry(),metadata=new Metadata(registry,metadataHex);registry.setMetadata(metadata);
 const factories=decorateExtrinsics(registry,registry.metadata,metadata.version),tx:any=(c:any)=>registry.createType('Extrinsic',{method:c});
 for(const [section,methods]of Object.entries(factories))tx[section]=Object.fromEntries(Object.entries(methods).map(([name,f])=>[name,(...args:unknown[])=>tx(f(...args))]));
 const batch:InvoiceBatch={id:'batch',title:'Invoice evidence',treasuryId:treasury.id,invoices:[invoice],asset:{...NATIVE_ASSET},totalRaw:invoice.amountRaw,createdAt:treasury.createdAt,createdBy:one.address,status:'paid',router:'0x1111111111111111111111111111111111111111',runtimeCodeHash:artifact.runtimeCodeHash,payer:'0x2222222222222222222222222222222222222222',recipients:['0x3333333333333333333333333333333333333333'],specVersion:1,weight:{refTime:'1000000',proofSize:'1000'},storageDepositRaw:'100',callHex:'',callHash:'',fundingBlock:42};
 const apiBase={registry,tx} as unknown as ApiPromise,inner=invoiceBatchCalls(apiBase,batch,treasury);batch.callHex=inner.method.toHex();batch.callHash=inner.method.hash.toHex();
 const extrinsic=tx.multisig.asMulti(2,treasury.signatories.filter(s=>s!==one.address),{height:40,index:1},inner.method,{refTime:'2000000',proofSize:'2000'});
 const blockHash='0x'+'b'.repeat(64);
 extrinsic.sign(one,{genesisHash:NETWORK.genesis,blockHash,nonce:0,runtimeVersion:{specVersion:1,transactionVersion:1}});
 batch.fundingTx=extrinsic.hash.toHex();
 const event=(section:string,method:string,data:any[]=[])=>({section,method,data});
 const log=(name:'InvoiceSettled'|'BatchSettled',data:Hex)=>event('revive','ContractEmitted',[batch.router,data,encodeEventTopics({abi:settlementAbi,eventName:name,args:name==='InvoiceSettled'?{payer:batch.payer,invoiceId:invoice.id}:{payer:batch.payer,batchHash:settlementBatchHash(batch)}} as any)]);
 const events:any[]=[event('system','ExtrinsicSuccess'),event('utility','BatchCompleted'),event('multisig','MultisigExecuted',[one.address,{height:40,index:1},treasury.address,{toHex:()=>batch.callHash},{isOk:true}]),
  log('InvoiceSettled',encodeAbiParameters([{type:'bytes32'},{type:'address'},{type:'address'},{type:'uint256'}],[invoice.termsHash,batch.asset.token,batch.recipients[0],BigInt(invoice.amountRaw)*10000n])),
  log('BatchSettled',encodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'}],[batch.asset.token,BigInt(invoice.amountRaw)*10000n,1n])),
  event('balances','Transfer',[routerAccount.address,recipient.address,invoice.amountRaw])];
 const records=()=>events.map(event=>({event,phase:{isApplyExtrinsic:true,asApplyExtrinsic:{toNumber:()=>0}}}));
 const at={registry,tx,query:{system:{events:async()=>records()}},call:{reviveApi:{code:async()=>({toHex:()=>u8aToHex(compactAddLength(hexToU8a(artifact.deployedBytecode)))}),address:async()=>({toString:()=>batch.payer}),
   accountId:async(address:string)=>({toString:()=>address===batch.payer?treasury.address:address===batch.router?routerAccount.address:recipient.address})}}};
 const api={...apiBase,runtimeVersion:{specVersion:{toNumber:()=>1}},genesisHash:{toHex:()=>NETWORK.genesis},rpc:{chain:{getBlockHash:async()=>({toHex:()=>blockHash}),getFinalizedHead:async()=>blockHash,getHeader:async()=>({number:{toNumber:()=>42}}),getBlock:async()=>({block:{extrinsics:[extrinsic]}})},state:{getMetadata:async()=>metadata}},at:async()=>at} as unknown as ApiPromise;
 const receipt:InvoiceReceipt={application:'PortaFlow',version:3,network:NETWORK,treasury,batch,transactions:[{txHash:batch.fundingTx!,blockHash,blockNumber:42,awardId:batch.id,kind:'funding',signer:one.address,feeRaw:'1',events:[],timestamp:treasury.createdAt}]};
 return {api,receipt,events,tx,extrinsic};
}
test('independent invoice verifier checks signed terms, historical native multisig call, contract code, events and actual transfers',async()=>{
 const {api,receipt}=fixture();const result=await verifyReceipt(api,receipt);
 assert.equal(result.status,'verified',JSON.stringify(result));assert.ok(result.checks.length>=13);
});
test('independent invoice verifier rejects missing or changed transfer evidence and forged contract logs',async()=>{
 for(const change of ['transfer','log','signature','commitment']){
  const {api,receipt,events}=fixture();
  if(change==='transfer')events.find(e=>e.section==='balances').data[2]='1';
  if(change==='log')events.find(e=>e.section==='revive').data[0]='0x4444444444444444444444444444444444444444';
  if(change==='signature')receipt.batch.invoices[0].title='Changed contribution';
  if(change==='commitment')events.filter(e=>e.section==='revive')[1].data[2][2]=zeroHash;
  assert.equal((await verifyReceipt(api,receipt)).status,'invalid',change);
 }
});
test('independent invoice verifier distinguishes unavailable native history from invalid payment evidence',async()=>{
 const {api,receipt}=fixture();(api.rpc.chain as any).getBlockHash=async()=>{throw new Error('History unavailable');};
 assert.equal((await verifyReceipt(api,receipt)).status,'unavailable');
});
test('wallet validation binds the exact signed invoices and the reviewed contract deployment bytecode',()=>{
 const {api,receipt,extrinsic,tx}=fixture();
 const plan={kind:'funding',signer:one.address,feeRaw:'1',depositRaw:'0',genesis:NETWORK.genesis,specVersion:1,callHex:extrinsic.method.toHex()};
 validatePlan(api,plan,{invoiceBatch:receipt.batch,treasury:receipt.treasury});
 assert.throws(()=>validatePlan(api,plan,{invoiceBatch:{...receipt.batch,router:'0x4444444444444444444444444444444444444444'},treasury:receipt.treasury}),/does not match/);
 const altered=structuredClone(receipt.batch);altered.invoices[0].amountRaw='1';
 assert.throws(()=>validatePlan(api,plan,{invoiceBatch:altered,treasury:receipt.treasury}),/signature|invalid/);
 const retry=invoiceBatchCalls(api,{...receipt.batch,id:'replacement-for-cancelled-batch'},receipt.treasury);
 assert.notEqual(retry.method.hash.toHex(),receipt.batch.callHash,'an unpaid retry must have its own multisig identity');
 const deploy=tx.revive.instantiateWithCode('0',{refTime:'100000',proofSize:'1000'},'100',artifact.bytecode,'0x',null);
 const deployPlan={...plan,kind:'settlement deployment',callHex:deploy.method.toHex(),storageDepositRaw:'100'};
 validatePlan(api,deployPlan,{settlementDeployment:true});
 assert.throws(()=>validatePlan(api,{...deployPlan,storageDepositRaw:'1'},{settlementDeployment:true}),/Unexpected/);
});
test('settlement history recovery reads finalized native events with an empty application database and supports pagination',async()=>{
 const {api,receipt}=fixture();const r=await recoverInvoiceSettlements(api,{router:receipt.batch.router,payer:receipt.batch.payer,fromBlock:42,limit:24});
 assert.equal(r.entries.length,1);assert.equal(r.entries[0].invoiceId,receipt.batch.invoices[0].id);assert.equal(r.entries[0].txHash,receipt.batch.fundingTx);assert.equal(r.nextBlock,43);
 await assert.rejects(()=>recoverInvoiceSettlements(api,{router:receipt.batch.router,payer:receipt.batch.payer,fromBlock:0}),/positive/);
});
test('invoice approvals use current contract and multisig state while global history is behind',async()=>{
 const {api,receipt}=fixture(),store=new Store(':memory:'),chain=new Chain(store,undefined,false),settlement=new InvoiceChain(chain);
 try{
  (api as any).isConnected=true;(api as any).consts={system:{blockWeights:{maxBlock:{refTime:100000000n,proofSize:1000000n}}}};
  const original=(api.tx as any).utility.batchAll;
  (api.tx as any).utility.batchAll=(...args:any[])=>Object.assign(original(...args),{paymentInfo:async()=>({weight:{refTime:1000000n,proofSize:1000n}})});
  chain.api=api;chain.state.verified=true;chain.state.connected=true;chain.state.specVersion=1;chain.state.finalizedBlock=99999;chain.state.lastSyncedBlock=1;
  chain.ready=async()=>{};chain.refreshHead=async()=>{};chain.synchronizeForApproval=async()=>{throw new Error('History catch-up must not run for an invoice approval.');};
  chain.pending=async()=>null;
  chain.wallet=async(address)=>({address,freeRaw:'10000000000000000',spendableRaw:'10000000000000000',reservedRaw:'0',frozenRaw:'0',vestingLockRaw:'0',remainingLockedRaw:'0',eligibleUnlockRaw:'0',schedules:[]});
  chain.estimate=async(call,signer,kind)=>({callHex:call.method.toHex(),signer,kind,feeRaw:'1',depositRaw:'0',genesis:NETWORK.genesis,specVersion:1});
  settlement.paid=async()=>[zeroHash];settlement.asset=async()=>({...NATIVE_ASSET});
  settlement.mappings=async()=>[{native:receipt.treasury.address,address:receipt.batch.payer,mapped:true},{native:recipient.address,address:receipt.batch.recipients[0],mapped:true}];
  const b={...receipt.batch,status:'draft' as const};
  const plan=await settlement.approvalPlan(b,receipt.treasury,one.address);assert.equal(plan.kind,'approval');
  settlement.paid=async()=>[b.invoices[0].termsHash];
  await assert.rejects(()=>settlement.approvalPlan(b,receipt.treasury,one.address),/already settled/);
 }finally{await store.close();}
});
test('invoice preparation reports an unfunded treasury before attempting a contract simulation',async()=>{
 const {api,receipt}=fixture(),store=new Store(':memory:'),chain=new Chain(store,undefined,false),settlement=new InvoiceChain(chain);
 try{
  settlement.verified=async()=>receipt.batch.router;
  settlement.snapshot=async()=>({api,at:{call:{reviveApi:{call:()=>{throw new Error('Simulation must not run without payment funds');}}}} as any,block:42n});
  settlement.asset=async()=>({...NATIVE_ASSET});settlement.paid=async()=>[zeroHash];
  settlement.mappings=async()=>[{native:receipt.treasury.address,address:receipt.batch.payer,mapped:true},{native:recipient.address,address:receipt.batch.recipients[0],mapped:true}];
  chain.wallet=async(address)=>({address,freeRaw:'10000000000000',spendableRaw:'0',reservedRaw:'0',frozenRaw:'0',vestingLockRaw:'0',remainingLockedRaw:'0',eligibleUnlockRaw:'0',schedules:[]});
  await assert.rejects(()=>settlement.prepare(receipt.batch,receipt.treasury),/Fund the treasury first: it has 0 tPOT spendable/);
 }finally{await store.close();}
});
test('failed history scans back off without blocking fresh chain heads or discarding their checkpoint',async()=>{
 const store=new Store(':memory:'),chain=new Chain(store,undefined,false);let heads=0,scans=0;
 try{
  chain.state.lastSyncedBlock=120;
  chain.refreshHead=async()=>{heads++;chain.state.finalizedBlock=200;};
  (chain as any).scanBlocks=async()=>{if(++scans===1)throw new Error('Historical RPC 503');};
  await assert.rejects(()=>chain.refresh(),/503/);assert.match(chain.state.historyError!,/checkpoint/);
  await chain.refresh();assert.equal(heads,2);assert.equal(scans,1);assert.equal(chain.state.lastSyncedBlock,120);
  await chain.scan();assert.equal(scans,2);assert.equal(chain.state.historyError,undefined);
 }finally{await store.close();}
});
