import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { NETWORK } from '../shared/types.js';
import { verifyReceipt } from '../server/verify.js';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: npm run verify:receipt -- path/to/receipt.json');
const contents = readFileSync(filename, 'utf8');
if (Buffer.byteLength(contents) > 262_144) throw new Error('Receipt must be under 256 KB.');
const document: unknown = JSON.parse(contents);
const provider = new WsProvider(NETWORK.rpc, false, {}, 10_000);
const api = new ApiPromise({ provider, noInitWarn: true });
const timeout = setTimeout(() => { console.error('Portaldot verification timed out.'); void provider.disconnect(); process.exitCode = 2; }, 45_000);
try {
  await provider.connect();
  await api.isReadyOrError;
  const result = await verifyReceipt(api, document);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'verified' ? 0 : result.status === 'invalid' ? 1 : 2;
} finally { clearTimeout(timeout); await api.disconnect(); }
