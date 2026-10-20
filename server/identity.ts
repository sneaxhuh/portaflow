import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decodeAddress, encodeAddress, signatureVerify, createKeyMulti } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { NETWORK } from '../shared/types.js';
import type { DataStore } from './store.js';

export function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || value.startsWith('0x')) throw new Error('Enter a native SS58 wallet address.');
  try {
    const key = decodeAddress(value);
    if (key.length !== 32) throw new Error('Expected a native account.');
    return encodeAddress(key, NETWORK.ss58);
  }
  catch { throw new Error('This native wallet address is invalid.'); }
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
export function sessionHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export async function createChallenge(store: DataStore, address: string, origin: string) {
  const id = randomUUID();
  const expires = Date.now() + 5 * 60_000;
  const message = ['PortaFlow sign-in', 'Origin: ' + origin, 'Network: ' + NETWORK.genesis, 'Wallet: ' + address, 'Nonce: ' + randomBytes(24).toString('hex'), 'Expires: ' + new Date(expires).toISOString(), '', 'This signature signs you in. It does not authorize a payment.'].join('\n');
  await store.saveChallenge({ id, address, message, expires });
  return { id, message, expires };
}
export async function verifyChallenge(store: DataStore, id: string, signature: string) {
  const challenge = await store.challenge(id);
  if (!challenge || challenge.expires < Date.now()) throw new Error('Sign-in expired. Connect your wallet again.');
  if (!signatureVerify(challenge.message, signature, challenge.address).isValid) throw new Error('The wallet signature is invalid.');
  if (!await store.consumeChallenge(id)) throw new Error('This sign-in challenge was already used. Connect your wallet again.');
  const token = randomBytes(32).toString('hex');
  await store.saveSession(sessionHash(token), { address: challenge.address, expires: Date.now() + 12 * 60 * 60_000 });
  return { token, address: challenge.address };
}
