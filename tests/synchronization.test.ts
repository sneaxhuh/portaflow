import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { Store } from '../server/store';
import { Chain } from '../server/chain';
import { NETWORK } from '../shared/types';

function fixture(head = 161) {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  const visited: number[] = [];
  chain.state.verified = true;
  chain.refreshHead = async () => { chain.state.finalizedBlock = head; };
  chain.api = {
    isConnected: true,
    rpc: { chain: { getBlockHash: async (height: number) => { visited.push(height); return height; } } },
    query: { system: { events: { at: async () => [] } } },
  } as unknown as ApiPromise;
  return { store, chain, visited };
}

test('approval drains multiple serverless scan batches without skipping any persisted history', async () => {
  const { store, chain, visited } = fixture(661);
  try {
    await store.setMeta('cursor:' + NETWORK.genesis, '100');
    await Promise.all([chain.synchronizeForApproval(), chain.synchronizeForApproval()]);
    assert.equal(chain.state.lastSyncedBlock, 661);
    assert.equal(await store.getMeta('cursor:' + NETWORK.genesis), '661');
    assert.deepEqual(visited, Array.from({ length: 561 }, (_, i) => i + 101));
  } finally { chain.api = undefined; await store.close(); }
});

test('scanner checkpoints complete windows and resumes after a failed RPC without skipping blocks', async () => {
  const { store, chain } = fixture();
  let fail = true, checkpoints = 0;
  const setMeta = store.setMeta.bind(store);
  store.setMeta = async (key, value) => { if (key.startsWith('cursor:')) checkpoints++; await setMeta(key, value); };
  (chain.api!.rpc.chain.getBlockHash as any) = async (height: number) => {
    if (fail && height === 119) throw new Error('RPC unavailable');
    return height;
  };
  try {
    await store.setMeta('cursor:' + NETWORK.genesis, '100');
    await chain.refreshHead();
    await assert.rejects(chain.scan(), /RPC unavailable/);
    assert.equal(await store.getMeta('cursor:' + NETWORK.genesis), '112');
    assert.equal(chain.state.lastSyncedBlock, 112);
    fail = false;
    await chain.scan();
    assert.equal(await store.getMeta('cursor:' + NETWORK.genesis), '161');
    assert.equal(checkpoints, 7, 'initial cursor plus six completed windows, not one write per block');
  } finally { chain.api = undefined; await store.close(); }
});

test('approval waits for another scanner and reports saved progress instead of issuing a stale plan', async () => {
  const { store, chain, visited } = fixture();
  try {
    await store.setMeta('cursor:' + NETWORK.genesis, '100');
    await store.acquireLease('chain:' + NETWORK.genesis, 'another-instance', 120_000);
    await assert.rejects(chain.synchronizeForApproval(0), error => {
      assert.match((error as Error).message, /61 blocks remaining.*indexed #100, target #161/);
      assert.equal((error as { statusCode: number }).statusCode, 503);
      return true;
    });
    assert.deepEqual(visited, []);
    await store.releaseLease('chain:' + NETWORK.genesis, 'another-instance');
    await chain.synchronizeForApproval();
    assert.equal(chain.state.lastSyncedBlock, 161);
  } finally { chain.api = undefined; await store.close(); }
});

test('approval targets its captured finalized height even if a concurrent refresh advances the head', async () => {
  const { store, chain } = fixture();
  try {
    chain.scan = async () => { chain.state.lastSyncedBlock = 161; chain.state.finalizedBlock = 162; };
    await chain.synchronizeForApproval(0);
    assert.equal(chain.state.lastSyncedBlock, 161);
  } finally { chain.api = undefined; await store.close(); }
});
