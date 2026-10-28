import { ApiPromise, WsProvider } from '@polkadot/api';
import { NETWORK, preparePayoutRound, deriveTreasury, normalizeAddress, type Treasury } from '../sdk/index.js';

// Real RPC reads and unsigned call construction only. No seed, key or signAndSend.
const [first, second, recipient] = process.argv.slice(2);
if (!first || !second || !recipient) throw new Error('Usage: npm run example:grant -- SIGNER_1 SIGNER_2 RECIPIENT');
const provider = new WsProvider(NETWORK.rpc, false, {}, 10_000);
const api = new ApiPromise({ provider, noInitWarn: true });
const timeout = setTimeout(() => { console.error('Portaldot connection timed out.'); void api.disconnect(); process.exitCode = 2; }, 45_000);
try {
  await provider.connect(); await api.isReadyOrError;
  const identity = deriveTreasury([first, second], 2);
  const treasury: Treasury = { id: 'integration-treasury', name: 'External grant program', ...identity, threshold: 2,
    creator: normalizeAddress(first), createdAt: new Date().toISOString() };
  const hash = await api.rpc.chain.getFinalizedHead(), header = await api.rpc.chain.getHeader(hash);
  const block = header.number.toNumber();
  const round = preparePayoutRound(api, { id: crypto.randomUUID(), title: 'External integration payout', treasury,
    createdBy: treasury.creator, createdAt: new Date().toISOString(), finalizedBlock: block, startBlock: block + 100,
    payments: [{ id: crypto.randomUUID(), title: 'Accepted contribution', recipient, amount: '1', upfront: '1', workUrl: 'https://github.com/sneaxhuh/portaflow' }] });
  console.log(JSON.stringify({ unsigned: true, submitted: false, treasury, round,
    nextStep: 'Review recipients and policy. Run balance, fee, weight and vesting checks, then collect native multisig signatures in your own integration.' }, null, 2));
} finally { clearTimeout(timeout); await api.disconnect(); }
