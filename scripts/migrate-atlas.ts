import { DatabaseSync } from 'node:sqlite';
import { MongoStore } from '../server/mongo-store.js';
import type { Award, Receipt, Treasury } from '../shared/types.js';

if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI securely in your environment before running the migration.');
const source = new DatabaseSync(process.env.PORTAFLOW_DB || '.portaflow/portaflow.sqlite', { readOnly: true });
const target = await MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'portaflow');
try {
  const treasuries = source.prepare('SELECT data FROM treasuries').all().map(row => JSON.parse(String(row.data)) as Treasury);
  const existing = await target.list<Treasury>('treasuries');
  if (treasuries.some(treasury => existing.some(row => row.address === treasury.address && row.id !== treasury.id))) {
    throw new Error('The target already has a treasury with the same address and a different workspace ID. Migration stopped to preserve its records.');
  }
  let treasuryCount = 0;
  for (const treasury of treasuries) if (!await target.treasury(treasury.id)) { await target.saveTreasury(treasury); treasuryCount++; }
  const awards = source.prepare('SELECT data FROM awards').all().map(row => JSON.parse(String(row.data)) as Award);
  const fresh: Award[] = [];
  for (const award of awards) if (!await target.award(award.id)) fresh.push(award);
  if (fresh.length) await target.saveAwards(fresh);
  const receipts = source.prepare('SELECT data FROM receipts').all().map(row => JSON.parse(String(row.data)) as Receipt);
  for (const receipt of receipts) await target.saveReceipt(receipt);
  for (const row of source.prepare("SELECT key, value FROM meta WHERE key LIKE 'cursor:%'").all()) {
    if (await target.getMeta(String(row.key)) === undefined) await target.setMeta(String(row.key), String(row.value));
  }
  console.log(`Migration complete: ${treasuryCount} new treasuries, ${fresh.length} new awards, ${receipts.length} receipts checked. Login sessions were excluded.`);
} finally { source.close(); await target.close(); }
