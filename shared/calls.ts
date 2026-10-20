import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import { stringToHex, stringToU8a } from '@polkadot/util';
import { canonical } from './money.js';
import { NETWORK, type Award, type Treasury } from './types.js';

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
  calls.push(api.tx.vesting.vestedTransfer(award.recipient, { locked: award.lockedRaw, perBlock: award.perBlockRaw, startingBlock: award.startBlock }));
  if (BigInt(award.upfrontRaw) > 0n) calls.push(api.tx.balances.transferKeepAlive(award.recipient, award.upfrontRaw));
  // Bytes treats Uint8Array input as already SCALE-encoded, including its
  // compact length. Hex input represents raw data and adds that length for us.
  calls.push(api.tx.system.remarkWithEvent(stringToHex(JSON.stringify({ app: 'PortaFlow', version: 1, awardId: award.id, termsHash }))));
  return api.tx.utility.batchAll(calls);
}
