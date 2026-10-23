import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import { stringToHex, stringToU8a } from '@polkadot/util';
import { canonical } from './money.js';
import { NETWORK, type Award, type Treasury, type PayoutRound } from './types.js';

export function transactionFromCall(api: ApiPromise, callHex: string) {
  // Stored plans contain SCALE Call bytes, without an extrinsic length or version.
  return api.tx(api.registry.createType('Call', callHex));
}

export function awardTermsHash(award: Award, treasury: Treasury) {
  return blake2AsHex(stringToU8a(canonical({
    version: 1, network: NETWORK.genesis, id: award.id, treasury: treasury.address,
    title: award.title, workUrl: award.workUrl, recipient: award.recipient,
    totalRaw: award.totalRaw, upfrontRaw: award.upfrontRaw, lockedRaw: award.lockedRaw,
    perBlockRaw: award.perBlockRaw, startBlock: award.startBlock,
  })));
}
export function fundingCall(api: ApiPromise, award: Award, treasury: Treasury) {
  const termsHash = awardTermsHash(award, treasury);
  const calls = [];
  // Create the recipient with the funded portion before a potentially small upfront transfer.
  if (BigInt(award.lockedRaw) > 0n) calls.push(api.tx.vesting.vestedTransfer(award.recipient, { locked: award.lockedRaw, perBlock: award.perBlockRaw, startingBlock: award.startBlock }));
  if (BigInt(award.upfrontRaw) > 0n) calls.push(api.tx.balances.transferKeepAlive(award.recipient, award.upfrontRaw));
  // Bytes treats Uint8Array input as already SCALE-encoded, including its
  // compact length. Hex input represents raw data and adds that length for us.
  calls.push(api.tx.system.remarkWithEvent(stringToHex(JSON.stringify({ app: 'PortaFlow', version: 1, awardId: award.id, termsHash }))));
  return api.tx.utility.batchAll(calls);
}

export function roundManifest(round: PayoutRound, treasury: Treasury) {
  return { version: 2, network: NETWORK.genesis, roundId: round.id, title: round.title,
    treasury: treasury.address, signatories: treasury.signatories, threshold: treasury.threshold,
    payments: round.awards.map(a => ({ id: a.id, title: a.title, recipient: a.recipient, workUrl: a.workUrl,
      totalRaw: a.totalRaw, upfrontRaw: a.upfrontRaw, lockedRaw: a.lockedRaw,
      perBlockRaw: a.perBlockRaw, startBlock: a.startBlock, endBlock: a.endBlock, durationBlocks: a.durationBlocks })) };
}
export function roundTermsHash(round: PayoutRound, treasury: Treasury) {
  return blake2AsHex(stringToU8a(canonical(roundManifest(round, treasury))));
}
export function roundFundingCall(api: ApiPromise, round: PayoutRound, treasury: Treasury) {
  const calls = round.awards.flatMap(award => {
    const result = [];
    if (BigInt(award.lockedRaw) > 0n) result.push(api.tx.vesting.vestedTransfer(award.recipient,
      { locked: award.lockedRaw, perBlock: award.perBlockRaw, startingBlock: award.startBlock }));
    if (BigInt(award.upfrontRaw) > 0n) result.push(api.tx.balances.transferKeepAlive(award.recipient, award.upfrontRaw));
    return result;
  });
  calls.push(api.tx.system.remarkWithEvent(stringToHex(JSON.stringify({ app: 'PortaFlow', version: 2,
    roundId: round.id, termsHash: roundTermsHash(round, treasury) }))));
  return api.tx.utility.batchAll(calls);
}
