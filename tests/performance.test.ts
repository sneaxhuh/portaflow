import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { request } from '../web/api';
import { Store } from '../server/store';
import { Chain } from '../server/chain';
import {rpcReadFailureMessage} from '../shared/rpc-errors';

test('optional best-header RPC failure does not block verified finalized state; finalized-header failure still blocks',async()=>{
  const store=new Store(':memory:'),chain=new Chain(store,undefined,false);let failFinalized=false;
  chain.state.verified=true;
  chain.api={isConnected:true,runtimeVersion:{specVersion:{toNumber:()=>3002}},rpc:{chain:{
    getFinalizedHead:async()=> 'finalized-hash',
    getHeader:async(hash?:string)=>{
      if(!hash)throw new Error('[503]: Failed HTTP Request: {"method":"chain_getHeader","params":[]}');
      if(failFinalized)throw new Error('Finalized header unavailable');
      return {number:{toNumber:()=>207492}};
    },
  }}} as unknown as ApiPromise;
  try{
    await chain.refreshHead();assert.equal(chain.state.finalizedBlock,207492);assert.equal(chain.state.bestBlock,207492);
    failFinalized=true;await assert.rejects(()=>chain.refreshHead(),/Finalized header unavailable/);
    assert.equal(chain.state.finalizedBlock,207492);
  }finally{chain.api=undefined;await store.close();}
});
test('header read errors explain uncertain transaction status and do not hide dispatch or submission failures',()=>{
  assert.match(rpcReadFailureMessage(new Error('[503]: Failed HTTP Request: {"method":"chain_getHeader","params":[]}'))!,/refresh the payment status/);
  assert.equal(rpcReadFailureMessage(new Error('balances.InsufficientBalance')),undefined);
  assert.equal(rpcReadFailureMessage(new Error('[503]: Failed HTTP Request: {"method":"author_submitExtrinsic","params":[]}')),undefined);
});

test('concurrent identical reads share transport but a completed balance is fetched afresh', async () => {
  const original = globalThis.fetch;
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => { calls++; await gate; return Response.json({ balance: calls }); };
  try {
    const first = request('/wallet/read-coalescing-test'), second = request('/wallet/read-coalescing-test');
    assert.equal(calls, 1); release();
    assert.deepEqual(await first, await second);
    await request('/wallet/read-coalescing-test'); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('signing-plan mutations are never merged', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ plan: calls }); };
  try {
    await Promise.all([request('/rounds/test/approval-plan', {}), request('/rounds/test/approval-plan', {})]);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('wallet snapshots reuse only the exact finalized block and refresh on the next block', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  let block = 100, queries = 0, free = '100';
  chain.state.verified = true;
  chain.state.existentialDepositRaw = '1';
  chain.api = {
    isConnected: true,
    rpc: { chain: { getFinalizedHead: async () => ({ toHex: () => String(block) }), getHeader: async () => ({ number: { toNumber: () => block } }) } },
    at: async () => { queries++; return { query: {
      system: { account: async () => ({ data: { free, frozen: '0', reserved: '0' } }) },
      vesting: { vesting: async () => ({ isSome: false }) }, balances: { locks: async () => [] },
    } }; },
  } as unknown as ApiPromise;
  try {
    await Promise.all([chain.wallet('recipient'), chain.wallet('recipient')]); assert.equal(queries, 1);
    block++; free = '200';
    const updated = await chain.wallet('recipient'); assert.equal(queries, 2); assert.equal(updated.freeRaw, '200');
  } finally { chain.api = undefined; await store.close(); }
});
