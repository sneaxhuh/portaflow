import test from 'node:test';
import assert from 'node:assert/strict';
import { TypeRegistry, Metadata } from '@polkadot/types';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import metadataHex from '@polkadot/types-support/metadata/static-substrate';
import { encodeAddress } from '@polkadot/util-crypto';
import type { ApiPromise } from '@polkadot/api';
import { NETWORK, preparePayoutRound, deriveTreasury, type Treasury } from '../sdk/index';
import { roundFundingCall, roundTermsHash } from '../shared/calls';
import { programReport, programReportCsv } from '../shared/report';
import { UNIT } from '../shared/money';
import { Store } from '../server/store';
import { Chain } from '../server/chain';
import { createApp } from '../server/app';

const native = (n: number) => encodeAddress(new Uint8Array(32).fill(n), 42);
const treasury: Treasury = { id: 'program', name: 'Community Grants', ...deriveTreasury([native(1), native(2)], 2), threshold: 2, creator: native(1), createdAt: '2026-10-26T00:00:00Z' };
const registry = new TypeRegistry(), metadata = new Metadata(registry, metadataHex);
registry.setMetadata(metadata);
const factories = decorateExtrinsics(registry, registry.metadata, metadata.version);
const tx: any = (call: any) => registry.createType('Extrinsic', { method: call });
for (const [section, methods] of Object.entries(factories)) tx[section] = Object.fromEntries(Object.entries(methods).map(([name, factory]) => [name, (...args: unknown[]) => tx(factory(...args))]));
const api = { registry, tx, genesisHash: { toHex: () => NETWORK.genesis }, runtimeVersion: { specVersion: { toNumber: () => 3002 } },
  consts: { vesting: { minVestedTransfer: 10n * UNIT } } } as unknown as ApiPromise;
const input = () => ({ id: 'round', title: 'October payouts', treasury, createdBy: treasury.creator, createdAt: treasury.createdAt, finalizedBlock: 100, startBlock: 130,
  payments: [{ id: 'one', title: 'Developer docs', recipient: native(3), amount: '20', upfront: '4', durationBlocks: 10 },
    { id: 'two', title: 'Small contribution', recipient: native(4), amount: '2', upfront: '2' }] });

test('standalone SDK produces the same canonical mixed payout as the application without a browser or database', () => {
  const round = preparePayoutRound(api, input());
  assert.equal(typeof window, 'undefined');
  assert.equal(round.totalRaw, String(22n * UNIT));
  assert.equal(round.callHex, roundFundingCall(api, round, treasury).method.toHex());
  assert.equal(round.termsHash, roundTermsHash(round, treasury));
  assert.equal(round.awards[0].startBlock, 130);
  assert.equal(round.awards[1].durationBlocks, 0);
  const tiny = input(); tiny.payments = [{ ...tiny.payments[1], amount: '0.00000000000001', upfront: '0.00000000000001' }];
  assert.equal(preparePayoutRound(api, tiny).totalRaw, '1');
});

test('SDK rejects a different chain, substituted policy, duplicate payment IDs and invalid native schedules', () => {
  assert.throws(() => preparePayoutRound({ ...api, genesisHash: { toHex: () => 'wrong' } } as unknown as ApiPromise, input()), /pinned Portaldot/);
  const wrong = input(); wrong.treasury = { ...treasury, address: native(8) };
  assert.throws(() => preparePayoutRound(api, wrong), /policy/);
  const duplicate = input(); duplicate.payments[1].id = duplicate.payments[0].id;
  assert.throws(() => preparePayoutRound(api, duplicate), /unique/);
  const minimum = input(); minimum.payments[0].amount = '5'; minimum.payments[0].upfront = '1';
  assert.throws(() => preparePayoutRound(api, minimum), /native minimum/);
  assert.throws(() => preparePayoutRound(api, { ...input(), startBlock: 100 }), /follow/);
  assert.throws(() => preparePayoutRound(api, { ...input(), payments: Array(26).fill(input().payments[0]) }), /1 and 25/);
});

function fundedData() {
  const round = { ...preparePayoutRound(api, input()), status: 'funded' as const, fundingBlock: 120, fundingTx: '0x' + 'b'.repeat(64) };
  const legacy = { ...round.awards[0], id: 'legacy', status: 'funded' as const, fundingBlock: 119, fundingTx: '0x' + 'a'.repeat(64) };
  return { round, legacy };
}
test('program totals count finalized legacy and round payments once and separate scheduled remainder from unlock state', () => {
  const { round, legacy } = fundedData();
  const draft = { ...legacy, id: 'draft', status: 'draft' as const, totalRaw: String(999n * UNIT) };
  const report = programReport(treasury, [legacy, draft, { ...legacy, id: 'another', treasuryId: 'another' }], [round], 135, 130);
  assert.equal(report.totals.fundedRaw, String(42n * UNIT));
  assert.equal(report.totals.immediateRaw, String(10n * UNIT));
  assert.equal(report.totals.remainingScheduledRaw, String(16n * UNIT));
  assert.equal(report.totals.earnedByScheduleRaw, String(16n * UNIT));
  assert.equal(report.totals.paymentCount, 3); assert.equal(report.totals.recipientCount, 2);
  assert.equal(report.totals.fundingTransactions, 2); assert.equal(report.totals.draftProposals, 1);
  assert.equal(report.historySynced, false); assert.equal(report.payments[1].fundingTx, round.fundingTx);
  assert.throws(() => programReport(treasury, [], [], 0, 0), /finalized/);
});
test('CSV exports preserve exact base-unit amounts and neutralize spreadsheet formulas in user fields', () => {
  const { legacy } = fundedData();
  const tiny = { ...legacy, title: '=HYPERLINK("bad")', totalRaw: '1', upfrontRaw: '1', lockedRaw: '0', perBlockRaw: '0', startBlock: 0, endBlock: 0 };
  const report = programReport({ ...treasury, name: '  +formula' }, [tiny], [], 135, 135);
  const csv = programReportCsv(report);
  assert.match(csv, /0\.00000000000001/);
  assert.ok(csv.includes('"\'  +formula"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
});
test('public report API works without a wallet, exports CSV and rejects missing workspaces', async () => {
  const store = new Store(':memory:'), chain = new Chain(store, undefined, false);
  const { round, legacy } = fundedData();
  await store.saveTreasury(treasury); await store.saveAward(legacy); await store.saveRound(round);
  await store.setMeta('cursor:' + NETWORK.genesis, '135');
  chain.refreshHead = async () => { chain.state.finalizedBlock = 135; };
  const { app } = await createApp({ store, chain, connect: false, serve: false });
  try {
    const result = await app.inject({ url: '/api/programs/program/report' });
    assert.equal(result.statusCode, 200); assert.equal(result.json().totals.fundedRaw, String(42n * UNIT));
    const csv = await app.inject({ url: '/api/programs/program/report?format=csv' });
    assert.equal(csv.statusCode, 200); assert.match(csv.headers['content-type']!, /text\/csv/);
    assert.match(csv.headers['content-disposition'] as string, /attachment/);
    assert.equal((await app.inject({ url: '/api/programs/missing/report' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/programs/program/report?format=html' })).statusCode, 400);
  } finally { await app.close(); }
});
