import {randomUUID} from 'node:crypto';
import {keccak256,type Address,type Hex} from 'viem';
import type {DataStore} from './store.js';
import type {Chain} from './chain.js';
import type {InvoiceChain} from './invoice-chain.js';
import {normalizeAddress} from '../shared/accounts.js';
import {matchesRuntimeCode} from '../shared/runtime-code.js';
import type {SettlementDeploymentReference} from '../shared/invoices.js';
import artifact from '../contracts/artifacts/InvoiceSettlement.json' with {type:'json'};

const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export const PENDING_DEPLOYMENT_KEY='invoice:settlement:pending-deployment';
export async function pendingSettlementDeployment(store:DataStore):Promise<SettlementDeploymentReference|undefined>{
  const raw=await store.getMeta(PENDING_DEPLOYMENT_KEY);
  if(!raw)return;
  try{const value=JSON.parse(raw);if(/^0x[0-9a-f]{64}$/i.test(value.txHash)&&/^0x[0-9a-f]{64}$/i.test(value.blockHash)&&typeof value.treasuryId==='string')return value;}catch{/* An incomplete local reference is not a deployment. */}
}

/** Reconcile a signed, finalized deployment. Never signs or submits a chain transaction. */
export async function registerSettlementDeployment(
  context:{store:DataStore;chain:Chain;settlement:InvoiceChain},signer:string,input:SettlementDeploymentReference,
){
  const {store,chain,settlement}=context,t=await store.treasury(input.treasuryId);
  if(!t||!t.signatories.includes(signer))throw failure('Only a treasury signer can register its settlement deployment.',403);
  if(!/^0x[0-9a-f]{64}$/i.test(input.txHash)||!/^0x[0-9a-f]{64}$/i.test(input.blockHash))throw failure('Provide a finalized native deployment transaction and block hash.');
  await chain.ready();await chain.refreshHead();const api=chain.requireApi();
  const header=await api.rpc.chain.getHeader(input.blockHash),number=header.number.toNumber();
  if(number>chain.state.finalizedBlock||(await api.rpc.chain.getBlockHash(number)).toHex()!==input.blockHash)throw failure('Deployment is not on the canonical finalized chain.');
  const block=await api.rpc.chain.getBlock(input.blockHash),at=await api.at(input.blockHash),index=block.block.extrinsics.findIndex(tx=>tx.hash.toHex()===input.txHash);
  if(index<0)throw failure('Deployment transaction is not present in this block.');
  const tx=at.registry.createType('Extrinsic',block.block.extrinsics[index].toHex()),method:any=tx.method;
  if(!tx.isSigned||normalizeAddress(tx.signer.toString())!==signer||method.section!=='revive'||method.method!=='instantiateWithCode'
    ||method.args[0].toString()!=='0'||keccak256(method.args[3].toHex())!==keccak256(artifact.bytecode as Hex)||method.args[4].toHex()!=='0x'||!method.args[5].isNone)throw failure('This is not the reviewed settlement deployment signed by your wallet.');
  const records:any=await at.query.system.events(),events:any[]=records.filter((r:any)=>r.phase.isApplyExtrinsic&&r.phase.asApplyExtrinsic.toNumber()===index).map((r:any)=>r.event);
  const deployed=events.find(e=>e.section==='revive'&&e.method==='Instantiated');
  if(!deployed||!events.some(e=>e.section==='system'&&e.method==='ExtrinsicSuccess'))throw failure('Successful contract instantiation was not found.');
  const address=deployed.data[1].toString().toLowerCase() as Address;
  const existing=await store.getMeta('invoice:settlement:address');
  if((existing&&existing!==address)||(settlement.address&&settlement.address.toLowerCase()!==address))throw failure('A different settlement contract is already pinned. It cannot be silently replaced.',409);
  // Preserve the paid-for deployment even if a subsequent code read is unavailable.
  await store.setMeta(PENDING_DEPLOYMENT_KEY,JSON.stringify({...input,address,blockNumber:number}));
  const nativeCode=(await (at.call as any).reviveApi.code(address)).toHex() as Hex;
  if(!matchesRuntimeCode(nativeCode,artifact.runtimeCodeHash as Hex))throw failure('Deployment finalized, but its code could not be verified. The existing deployment reference is saved; do not deploy again.');
  const evmCode=await settlement.client.getCode({address,blockNumber:BigInt(number)});
  if(!evmCode||keccak256(evmCode)!==artifact.runtimeCodeHash)throw failure('The EVM code view does not match the reviewed contract. The deployment reference is saved; retry registration rather than deploying again.');
  const owner=randomUUID(),lease='invoice-settlement-install';
  if(!await store.acquireLease(lease,owner,15000))throw failure('Another installation is being recorded. Retry shortly.',409);
  try{
    const pinned=await store.getMeta('invoice:settlement:address');
    if(pinned&&pinned!==address)throw failure('A different settlement contract is already pinned.',409);
    await store.setMeta('invoice:settlement:address',address);
    await store.setMeta('invoice:settlement:deployment',JSON.stringify({txHash:input.txHash,blockHash:input.blockHash,blockNumber:number}));
    await store.setMeta(PENDING_DEPLOYMENT_KEY,'');settlement.address=address;
  }finally{await store.releaseLease(lease,owner);}
  return settlement.status();
}
