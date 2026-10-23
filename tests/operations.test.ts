import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TypeRegistry, Metadata } from '@polkadot/types';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import fallbackMetadata from '@polkadot/types-support/metadata/static-substrate';
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto';
import type { ApiPromise } from '@polkadot/api';
import { Store } from '../server/store';
import { Chain, fundingSucceeded } from '../server/chain';
import { createApp } from '../server/app';
import { sessionHash, treasuryIdentity } from '../server/identity';
import { verifyReceipt } from '../server/verify';
import { fundingCall, roundFundingCall, roundTermsHash } from '../shared/calls';
import { formatAmount, schedule, UNIT } from '../shared/money';
import { readAwardCsv } from '../shared/import';
import { NETWORK, type Award, type PayoutRound, type Treasury, type WalletState } from '../shared/types';
import { validatePlan } from '../web/wallet';

const native = (n: number) => encodeAddress(new Uint8Array(32).fill(n), 42);
const treasury: Treasury = { id: 'treasury', name: 'Contributors', ...treasuryIdentity([native(1), native(2)], 2), threshold: 2, creator: native(1), createdAt: '2026-10-23T00:00:00Z', createdBlock: 100 };
const award = (id = 'payment', immediate = false): Award => ({ id, treasuryId: treasury.id, title: 'Contributor ' + id, recipient: native(3), workUrl: '', totalRaw: (20n * UNIT).toString(), upfrontRaw: ((immediate ? 20n : 4n) * UNIT).toString(), lockedRaw: ((immediate ? 0n : 16n) * UNIT).toString(), perBlockRaw: immediate ? '0' : (16n * UNIT / 10n).toString(), startBlock: immediate ? 0 : 130, durationBlocks: immediate ? 0 : 10, endBlock: immediate ? 0 : 140, createdAt: '2026-10-23T00:00:00Z', createdBy: native(1), createdBlock: 100, status: 'draft' });
const round = (): PayoutRound => ({ id: 'round', treasuryId: treasury.id, title: 'Contributor round', awards: [award('a'), award('b', true)], totalRaw: (40n * UNIT).toString(), upfrontRaw: (24n * UNIT).toString(), lockedRaw: (16n * UNIT).toString(), createdAt: '2026-10-23T00:00:00Z', createdBy: native(1), createdBlock: 100, startDelayBlocks: 30, status: 'draft' });
const wallet = (address = treasury.address): WalletState => ({ address, freeRaw: (1000n * UNIT).toString(), spendableRaw: (999n * UNIT).toString(), frozenRaw: '0', reservedRaw: '0', vestingLockRaw: '0', remainingLockedRaw: '0', eligibleUnlockRaw: '0', schedules: [] });

function encodingApi() {
  const registry = new TypeRegistry();
  const hex = process.env.PORTAFLOW_TEST_METADATA ? readFileSync(process.env.PORTAFLOW_TEST_METADATA, 'utf8').trim() : fallbackMetadata;
  const metadata = new Metadata(registry, hex as `0x${string}`); registry.setMetadata(metadata);
  const factories = decorateExtrinsics(registry, registry.metadata, metadata.version);
  const tx: any = (call: any) => registry.createType('Extrinsic', { method: call });
  for (const [section, methods] of Object.entries(factories)) tx[section] = Object.fromEntries(Object.entries(methods).map(([name, factory]) => [name, (...args: unknown[]) => tx(factory(...args))]));
  return { registry, tx, genesisHash: { toHex: () => NETWORK.genesis }, runtimeVersion: { specVersion: { toNumber: () => 3002 } } } as unknown as ApiPromise;
}
const api = encodingApi();

test('round encodes vested and immediate payments in one atomic batch with one commitment', () => {
  const call = roundFundingCall(api, round(), treasury);
  const calls = [...call.method.args[0] as any];
  assert.deepEqual(calls.map(c => c.section + '.' + c.method), ['vesting.vestedTransfer', 'balances.transferKeepAlive', 'balances.transferKeepAlive', 'system.remarkWithEvent']);
  assert.equal(call.method.method, 'batchAll');
  const immediate = fundingCall(api, award('immediate', true), treasury);
  assert.deepEqual([...immediate.method.args[0] as any].map(c => c.section), ['balances', 'system']);
});

test('terms hash changes for every material payment, order, or signer-policy change', () => {
  const original = roundTermsHash(round(), treasury);
  const change = (mutate: (r: PayoutRound) => void) => { const r = round(); mutate(r); assert.notEqual(roundTermsHash(r, treasury), original); };
  change(r => { r.awards[0].recipient = native(4); });
  change(r => { r.awards[0].totalRaw = '7'; });
  change(r => { r.awards[0].startBlock++; });
  change(r => { r.awards[0].workUrl = 'https://github.com/example/work'; });
  change(r => { r.awards.reverse(); });
  assert.notEqual(roundTermsHash(round(), { ...treasury, threshold: 3 }), original);
});

test('browser accepts the exact round and rejects a substituted payout call', () => {
  const r = round(), batch = roundFundingCall(api, r, treasury);
  const call = api.tx.multisig.asMulti(2, treasury.signatories.filter(s => s !== native(1)), { height: 100, index: 1 }, batch.method, { refTime: 1, proofSize: 0 });
  const plan = { callHex: call.method.toHex(), signer: native(1), genesis: NETWORK.genesis, specVersion: 3002, kind: 'funding', feeRaw: '1', depositRaw: '0' };
  assert.doesNotThrow(() => validatePlan(api, plan, { round: r, treasury }));
  const changed = structuredClone(r); changed.awards[0].recipient = native(4);
  assert.throws(() => validatePlan(api, plan, { round: changed, treasury }), /does not match/);
  assert.throws(() => validatePlan(api, { ...plan, genesis: 'wrong' }, { round: r, treasury }), /Network/);
});

test('outer extrinsic success alone never counts as funded', () => {
  assert.equal(fundingSucceeded(true, ['ExtrinsicSuccess']), false);
  assert.equal(fundingSucceeded(false, ['BatchCompleted', 'ExtrinsicSuccess']), false);
  assert.equal(fundingSucceeded(true, ['BatchInterrupted', 'ExtrinsicSuccess']), false);
  assert.equal(fundingSucceeded(true, ['BatchCompleted', 'ExtrinsicSuccess']), true);
});

test('immediate CSV rows, small amounts, and schedule rounding are exact', () => {
  const rows = readAwardCsv('title,recipient,amount,upfront_percent,duration_days\nSmall payment,' + native(3) + ',0.00000000000001,100,1');
  assert.equal(rows[0].upfront, '0.00000000000001');
  assert.equal(formatAmount('1'), '0.00000000000001');
  const s = schedule(101n, 10, 100);
  assert.equal(s.perBlockRaw, '10'); assert.equal(s.endBlock, 111);
});

test('API creates one round, preserves legacy awards, and rejects unauthorized or invalid batches atomically', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  chain.api = { isConnected: true } as ApiPromise;
  chain.state = { ...chain.state, connected: true, verified: true, bestBlock: 100, finalizedBlock: 100, lastSyncedBlock: 100, minVestedRaw: (10n * UNIT).toString(), blockSeconds: 6 };
  chain.refreshHead = async () => {};
  chain.wallet = async address => wallet(address);
  await store.saveTreasury(treasury); await store.saveAward(award('legacy'));
  const token = 'a'.repeat(64); await store.saveSession(sessionHash(token), { address: native(1), expires: Date.now() + 60000 });
  const { app } = await createApp({ store, chain, connect: false, serve: false });
  const payload = { treasuryId: treasury.id, title: 'Real contributors', startDelayBlocks: 30, acceptedCommitment: true, payments: [
    { title: 'Immediate', recipient: native(3), amount: '2', upfront: '2', durationBlocks: 10 },
    { title: 'Vested', recipient: native(4), amount: '20', upfront: '4', durationBlocks: 10 },
  ] };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/rounds', payload })).statusCode, 401);
    const create = (value: unknown) => app.inject({ method: 'POST', url: '/api/rounds', headers: { cookie: 'portaflow_session=' + token }, payload: value as any });
    const result = await create(payload); assert.equal(result.statusCode, 200, result.body);
    const r = result.json<PayoutRound>(); assert.equal(r.awards.length, 2); assert.equal(r.totalRaw, (22n * UNIT).toString());
    assert.equal(r.awards[0].startBlock, 0); assert.equal(r.awards[0].endBlock, 0);
    assert.equal((await store.list('awards')).length, 1);
    const invalid = structuredClone(payload); invalid.payments[1].upfront = '30';
    assert.equal((await create(invalid)).statusCode, 400); assert.equal((await store.list('rounds')).length, 1);
    assert.equal((await create({ ...payload, payments: new Array(26).fill(payload.payments[0]) })).statusCode, 400);
    await store.saveRound({ ...r, status: 'funded' });
    const portal = (await app.inject({ url: '/api/recipient/' + native(3) })).json();
    assert.equal(portal.totalFundedRaw, (2n * UNIT).toString()); assert.equal(portal.awards[0].roundId, r.id);
  } finally { chain.api = undefined; await app.close(); }
});

test('block indexing records deposits with no prepared awards and is idempotent', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  await store.saveTreasury(treasury); await store.setMeta('cursor:' + NETWORK.genesis, '100');
  const data: any = [native(1), treasury.address, (20n * UNIT).toString()]; data.toJSON = () => [...data];
  const records: any = [{ phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } }, event: { section: 'balances', method: 'Transfer', data } }];
  const blockHash = '0x' + 'b'.repeat(64), txHash = '0x' + 'a'.repeat(64);
  chain.api = { isConnected: true, rpc: { chain: { getBlockHash: async () => ({ toHex: () => blockHash }), getBlock: async () => ({ block: { extrinsics: [{ hash: { toHex: () => txHash }, isSigned: true, signer: native(1) }] } }) } }, query: { system: { events: { at: async () => records } }, timestamp: { now: { at: async () => Date.now() } } } } as unknown as ApiPromise;
  chain.state = { ...chain.state, verified: true, connected: true, finalizedBlock: 101 };
  try {
    await chain.scan(); assert.equal(chain.state.lastSyncedBlock, 101);
    const entries = await store.ledger(treasury.id); assert.equal(entries.length, 1); assert.equal(entries[0].direction, 'incoming');
    await store.setMeta('cursor:' + NETWORK.genesis, '100'); await chain.scan(); assert.equal((await store.ledger(treasury.id)).length, 1);
  } finally { chain.api = undefined; await store.close(); }
});

test('receipt verifier rejects a tampered manifest before consulting the chain or database', async () => {
  const r = round(); r.termsHash = roundTermsHash(r, treasury); r.awards[0].recipient = native(4);
  const result = await verifyReceipt(api, { application: 'PortaFlow', version: 2, network: NETWORK, treasury, round: r, transactions: [] });
  assert.equal(result.status, 'invalid'); assert.equal(result.checks.at(-1)?.label, 'Manifest commitment');
});

test('first review freezes round schedules across later signers and refuses concurrent preparation', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  chain.api = Object.assign(api, { isConnected: true });
  chain.state = { ...chain.state, verified: true, bestBlock: 100, finalizedBlock: 100, specVersion: 3002 };
  const r = round(); await store.saveRound(r);
  try {
    const first = await chain.prepareRound(r, treasury);
    chain.state.bestBlock = 110;
    const next = await chain.prepareRound(r, treasury);
    assert.equal(first.callHash, next.callHash); assert.equal(next.awards[0].startBlock, 130);
    await store.acquireLease('prepare-round:' + r.id, 'other-reviewer', 30000);
    await assert.rejects(chain.prepareRound(r, treasury), /Another signer/);
  } finally { chain.api = undefined; await store.close(); }
});

test('round preflight checks aggregate vesting slots for repeated recipients', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  chain.api = Object.assign(api, { isConnected: true });
  chain.state = { ...chain.state, verified: true, bestBlock: 100, finalizedBlock: 100, lastSyncedBlock: 100, specVersion: 3002, maxSchedules: 1 };
  chain.refresh = async () => {}; chain.wallet = async address => wallet(address); chain.pending = async () => null;
  const r = round(); r.awards = [award('one'), award('two')]; r.upfrontRaw = String(8n * UNIT); r.lockedRaw = String(32n * UNIT);
  await store.saveRound(r);
  try { await assert.rejects(chain.roundApprovalPlan(r, treasury, native(1)), /vesting schedule limit/); }
  finally { chain.api = undefined; await store.close(); }
});
