import { createKeyMulti, decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { NETWORK } from './types.js';

export function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || value.startsWith('0x')) throw new Error('Enter a native SS58 wallet address.');
  try {
    const key = decodeAddress(value);
    if (key.length !== 32) throw new Error('Expected a native account.');
    return encodeAddress(key, NETWORK.ss58);
  } catch { throw new Error('This native wallet address is invalid.'); }
}
export function sameAddress(a: string, b: string) {
  try { return u8aToHex(decodeAddress(a)) === u8aToHex(decodeAddress(b)); } catch { return false; }
}
export function treasuryIdentity(addresses: string[], threshold: number) {
  const signatories = addresses.map(normalizeAddress).sort((a, b) => u8aToHex(decodeAddress(a)).localeCompare(u8aToHex(decodeAddress(b))));
  if (new Set(signatories).size !== signatories.length) throw new Error('Each treasury signer must have a different wallet.');
  if (signatories.length < 2 || signatories.length > 5 || threshold < 2 || threshold > signatories.length || !Number.isInteger(threshold)) throw new Error('Use 2–5 signers and a valid approval threshold.');
  return { signatories, address: encodeAddress(createKeyMulti(signatories, threshold), NETWORK.ss58) };
}
