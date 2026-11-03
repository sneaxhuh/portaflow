import test from 'node:test';
import assert from 'node:assert/strict';
import {retryRpcRead,withRpcReadRetries,RpcReadTimeout} from '../shared/rpc-policy';
import type {ProviderInterface} from '@polkadot/rpc-provider/types';
test('retryable reads use bounded exponential backoff with jitter and recover after 503',async()=>{
 let attempts=0;const delays:number[]=[];
 const result=await retryRpcRead(async()=>{if(++attempts<3)throw new Error('[503]: Failed HTTP Request');return 'verified';},{random:()=>0,sleep:async ms=>{delays.push(ms);}});
 assert.equal(result,'verified');assert.equal(attempts,3);assert.deepEqual(delays,[125,250]);
});
test('timeouts have a bounded number of attempts; permanent errors do not retry',async()=>{
 let attempts=0;
 await assert.rejects(()=>retryRpcRead(()=>{attempts++;return new Promise(()=>{});},{attempts:2,timeoutMs:5,sleep:async()=>{}}),RpcReadTimeout);assert.equal(attempts,2);
 attempts=0;await assert.rejects(()=>retryRpcRead(async()=>{attempts++;throw new Error('BadProof');}),/BadProof/);assert.equal(attempts,1);
});
test('transport retries only whitelisted reads, never submissions, signing or unknown methods',async()=>{
 const counts=new Map<string,number>();
 const provider={send:async(method:string)=>{counts.set(method,(counts.get(method)||0)+1);throw new Error('503');},clone(){return this;}} as unknown as ProviderInterface;
 withRpcReadRetries(provider);
 for(const method of ['author_submitExtrinsic','author_submitAndWatchExtrinsic','eth_sendRawTransaction','eth_sendTransaction','signer_signPayload','unrecognized_read']){
  await assert.rejects(()=>provider.send(method,[]),/503/);assert.equal(counts.get(method),1);
 }
});
test('a read retry bypasses a provider cached failure and repeated decoration does not multiply retry attempts',async()=>{
 const cacheFlags:(boolean|undefined)[]=[];
 const provider={send:async(_method:string,_params:unknown[],cacheable?:boolean)=>{cacheFlags.push(cacheable);if(cacheable)throw new Error('503');return 'recovered';},clone(){return this;}} as unknown as ProviderInterface;
 withRpcReadRetries(provider);withRpcReadRetries(provider);
 assert.equal(await provider.send('chain_getHeader',[],true),'recovered');assert.deepEqual(cacheFlags,[true,false]);
});
