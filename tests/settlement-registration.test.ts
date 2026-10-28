import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compactAddLength,hexToU8a,u8aToHex} from '@polkadot/util';
import {encodeAddress} from '@polkadot/util-crypto';
import {Store} from '../server/store';
import {Chain} from '../server/chain';
import {InvoiceChain} from '../server/invoice-chain';
import {pendingSettlementDeployment,registerSettlementDeployment} from '../server/settlement-deployment';
import {treasuryIdentity} from '../shared/accounts';
import type {Treasury} from '../shared/types';

const artifact=JSON.parse(readFileSync('contracts/artifacts/InvoiceSettlement.json','utf8'));
async function fixture(){
  const signer=encodeAddress(new Uint8Array(32).fill(1),42),other=encodeAddress(new Uint8Array(32).fill(2),42);
  const treasury:Treasury={id:'test',name:'Test',...treasuryIdentity([signer,other],2),threshold:2,creator:signer,createdAt:new Date().toISOString()};
  const store=new Store(':memory:');await store.saveTreasury(treasury);
  const reference={treasuryId:treasury.id,txHash:'0x'+'a'.repeat(64),blockHash:'0x'+'b'.repeat(64)};
  const address='0x'+'1'.repeat(40);
  const extrinsic:any={isSigned:true,signer:{toString:()=>signer},hash:{toHex:()=>reference.txHash},toHex:()=> '0x0102',method:{section:'revive',method:'instantiateWithCode',args:[{toString:()=> '0'},null,null,{toHex:()=>artifact.bytecode},{toHex:()=> '0x'},{isNone:true}]}};
  let nativeCode=u8aToHex(compactAddLength(hexToU8a(artifact.deployedBytecode))),evmCode=artifact.deployedBytecode,success=true;
  const events=()=>[{section:'revive',method:'Instantiated',data:[signer,address]},...(success?[{section:'system',method:'ExtrinsicSuccess',data:[]}]:[])].map(event=>({event,phase:{isApplyExtrinsic:true,asApplyExtrinsic:{toNumber:()=>0}}}));
  const api={rpc:{chain:{getHeader:async()=>({number:{toNumber:()=>207101}}),getBlockHash:async()=>({toHex:()=>reference.blockHash}),getBlock:async()=>({block:{extrinsics:[extrinsic]}})}},at:async()=>({registry:{createType:()=>extrinsic},query:{system:{events:async()=>events()}},call:{reviveApi:{code:async()=>({toHex:()=>nativeCode})}}})};
  const chain=new Chain(store,'unused',false);chain.state.finalizedBlock=207102;chain.ready=async()=>{};chain.refreshHead=async()=>{};chain.requireApi=()=>api as any;
  const settlement=new InvoiceChain(chain,'');settlement.client={getCode:async()=>evmCode} as any;
  settlement.status=async()=>({configured:Boolean(settlement.address),verified:Boolean(settlement.address),runtimeCodeHash:artifact.runtimeCodeHash,address:settlement.address as any});
  return {context:{store,chain,settlement},signer,other,reference,address,setNative:(v:string)=>{nativeCode=v as any;},setEvm:(v:string)=>{evmCode=v;},failTx:()=>{success=false;}};
}
test('registration recovers the paid deployment with SCALE-wrapped native code and raw EVM code; retry is idempotent',async()=>{
  const f=await fixture();try{
    const status=await registerSettlementDeployment(f.context,f.signer,f.reference);
    assert.equal(status.verified,true);assert.equal(status.address,f.address);
    assert.equal(await f.context.store.getMeta('invoice:settlement:address'),f.address);
    assert.equal(await pendingSettlementDeployment(f.context.store),undefined);
    assert.equal((await registerSettlementDeployment(f.context,f.signer,f.reference)).address,f.address);
  }finally{await f.context.store.close();}
});
test('registration retains the paid deployment reference when either independent code view mismatches',async()=>{
  for(const side of ['native','evm']){
    const f=await fixture();try{
      if(side==='native')f.setNative('0x6000');else f.setEvm('0x6000');
      await assert.rejects(registerSettlementDeployment(f.context,f.signer,f.reference),/code|EVM/);
      assert.equal(await f.context.store.getMeta('invoice:settlement:address'),undefined);
      assert.equal((await pendingSettlementDeployment(f.context.store))?.txHash,f.reference.txHash);
    }finally{await f.context.store.close();}
  }
});
test('registration requires the actual deployer and successful finalized transaction',async()=>{
  const f=await fixture();try{
    await assert.rejects(registerSettlementDeployment(f.context,f.other,f.reference),/signed by your wallet/);
    f.failTx();await assert.rejects(registerSettlementDeployment(f.context,f.signer,f.reference),/Successful contract/);
    assert.equal(await pendingSettlementDeployment(f.context.store),undefined);
  }finally{await f.context.store.close();}
});
