import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { Store } from '../server/store';
import { Chain } from '../server/chain';
import { NETWORK } from '../shared/types';

function fixture() {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  const visited: number[] = [];
  chain.state.verified = true;
  chain.refreshHead = async () => { chain.state.finalizedBlock = 161; };
  chain.api = {
    isConnected: true,
    rpc: { chain: { getBlockHash: async (height: number) => { visited.push(height); return height; } } },
    query: { system: { events: { at: async () => [] } } },
  } as unknown as ApiPromise;
  return { store, chain, visited };
}

test('approval drains multiple serverless scan batches without skipping any persisted history', async () => {
  const { store, chain, visited } = fixture();
  try {
    await store.setMeta('cursor:' + NETWORK.genesis, '100');
    await Promise.all([chain.synchronizeForApproval(), chain.synchronizeForApproval()]);
    assert.equal(chain.state.lastSyncedBlock, 161);
    assert.equal(await store.getMeta('cursor:' + NETWORK.genesis), '161');
    assert.deepEqual(visited, Array.from({ length: 61 }, (_, i) => i + 101));
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
