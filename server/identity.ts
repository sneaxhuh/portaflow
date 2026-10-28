import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { signatureVerify } from '@polkadot/util-crypto';
import { NETWORK } from '../shared/types.js';
import type { DataStore } from './store.js';

export { normalizeAddress, sameAddress, treasuryIdentity } from '../shared/accounts.js';
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
