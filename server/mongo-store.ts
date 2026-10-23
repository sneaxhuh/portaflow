import { MongoClient, MongoServerError, type Db, type Collection, type Document } from 'mongodb';
import type { Award, Receipt, Treasury, PayoutRound, LedgerEntry } from '../shared/types.js';
import type { Challenge, DataStore, Session } from './store.js';

type Entry<T> = { _id: string; data: T; callHash?: string };
type Expiring<T> = { _id: string; data: T; expiresAt: Date };

export class MongoStore implements DataStore {
  private constructor(private client: MongoClient, private db: Db) {}
  static async connect(uri: string, database: string) {
    const client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 8_000, waitQueueTimeoutMS: 8_000 });
    try {
      await client.connect();
      const store = new MongoStore(client, client.db(database));
      await store.indexes();
      return store;
    } catch (error) { await client.close(); throw error; }
  }
  private collection<T extends Document>(name: string): Collection<T> { return this.db.collection<T>(name); }
  private async indexes() {
    await Promise.all([
      this.db.collection('treasuries').createIndex({ 'data.address': 1 }, { unique: true }),
      this.db.collection('awards').createIndex({ callHash: 1 }, { unique: true, partialFilterExpression: { callHash: { $type: 'string' } } }),
      this.db.collection('rounds').createIndex({ callHash: 1 }, { unique: true, partialFilterExpression: { callHash: { $type: 'string' } } }),
      this.db.collection('ledger').createIndex({ 'data.treasuryId': 1, 'data.blockNumber': -1 }),
      this.db.collection('receipts').createIndex({ 'data.awardId': 1, 'data.blockNumber': 1 }),
      ...['sessions', 'challenges'].map(name => this.db.collection(name).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })),
    ]);
  }
  async list<T>(table: 'treasuries' | 'awards' | 'rounds'): Promise<T[]> {
    return (await this.collection<Entry<T>>(table).find({}).sort({ 'data.createdAt': -1, _id: -1 }).toArray()).map(row => row.data);
  }
  async treasury(id: string) { return (await this.collection<Entry<Treasury>>('treasuries').findOne({ _id: id }))?.data; }
  async award(id: string) { return (await this.collection<Entry<Award>>('awards').findOne({ _id: id }))?.data; }
  async saveTreasury(treasury: Treasury) {
    await this.collection<Entry<Treasury>>('treasuries').insertOne({ _id: treasury.id, data: treasury });
  }
  private awardEntry(award: Award): Entry<Award> {
    return { _id: award.id, data: award, ...(award.callHash ? { callHash: award.callHash } : {}) };
  }
  async saveAward(award: Award) {
    await this.collection<Entry<Award>>('awards').replaceOne({ _id: award.id }, this.awardEntry(award), { upsert: true });
  }
  async saveAwards(awards: Award[]) {
    const session = this.client.startSession();
    try { await session.withTransaction(async () => {
      await this.collection<Entry<Award>>('awards').insertMany(awards.map(award => this.awardEntry(award)), { session });
    }); } finally { await session.endSession(); }
  }
  async saveReceipt(receipt: Receipt) {
    await this.collection<Entry<Receipt>>('receipts').updateOne({ _id: receipt.awardId + ':' + receipt.txHash },
      { $setOnInsert: { data: receipt } }, { upsert: true });
  }
  async receipts(id: string) {
    return (await this.collection<Entry<Receipt>>('receipts').find({ 'data.awardId': id })
      .sort({ 'data.blockNumber': 1, 'data.extrinsicIndex': 1, _id: 1 }).toArray()).map(row => row.data);
  }
  async round(id: string) { return (await this.collection<Entry<PayoutRound>>('rounds').findOne({ _id: id }))?.data; }
  async saveRound(round: PayoutRound) {
    await this.collection<Entry<PayoutRound>>('rounds').replaceOne({ _id: round.id },
      { data: round, ...(round.callHash ? { callHash: round.callHash } : {}) }, { upsert: true });
  }
  async saveLedger(entry: LedgerEntry) {
    await this.collection<Entry<LedgerEntry>>('ledger').updateOne({ _id: entry.id }, { $setOnInsert: { data: entry } }, { upsert: true });
  }
  async ledger(treasuryId: string) {
    return (await this.collection<Entry<LedgerEntry>>('ledger').find({ 'data.treasuryId': treasuryId })
      .sort({ 'data.blockNumber': -1, 'data.extrinsicIndex': -1, 'data.eventIndex': -1 }).limit(500).toArray()).map(row => row.data);
  }
  async getMeta(key: string) { return (await this.collection<{ _id: string; value: string }>('meta').findOne({ _id: key }))?.value; }
  async setMeta(key: string, value: string) {
    await this.collection<{ _id: string; value: string }>('meta').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  }
  async saveChallenge(challenge: Challenge) {
    await this.collection<Expiring<Challenge>>('challenges').insertOne({ _id: challenge.id, data: challenge, expiresAt: new Date(challenge.expires) });
  }
  async challenge(id: string) { return (await this.collection<Expiring<Challenge>>('challenges').findOne({ _id: id, expiresAt: { $gt: new Date() } }))?.data; }
  async consumeChallenge(id: string) {
    return (await this.collection<Expiring<Challenge>>('challenges').deleteOne({ _id: id, expiresAt: { $gt: new Date() } })).deletedCount === 1;
  }
  async saveSession(hash: string, session: Session) {
    await this.collection<Expiring<Session>>('sessions').insertOne({ _id: hash, data: session, expiresAt: new Date(session.expires) });
  }
  async session(hash: string) { return (await this.collection<Expiring<Session>>('sessions').findOne({ _id: hash, expiresAt: { $gt: new Date() } }))?.data; }
  async deleteSession(hash: string) { await this.collection<Expiring<Session>>('sessions').deleteOne({ _id: hash }); }
  async acquireLease(key: string, owner: string, ttlMs: number) {
    try {
      const result = await this.collection<{ _id: string; owner: string; expiresAt: Date }>('leases').findOneAndUpdate(
        { _id: key, $or: [{ expiresAt: { $lte: new Date() } }, { owner }] },
        { $set: { owner, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true, returnDocument: 'after' });
      return result?.owner === owner;
    } catch (error) { if (error instanceof MongoServerError && error.code === 11000) return false; throw error; }
  }
  async releaseLease(key: string, owner: string) { await this.collection<{ _id: string; owner: string }>('leases').deleteOne({ _id: key, owner }); }
  async sponsoredToday() {
    const day = new Date().toISOString().slice(0, 10);
    return (await this.db.collection('sponsored').find({ day }).toArray()).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  }
  async reserveSponsored(txHash: string, day: string, amount: string) {
    await this.collection<{ _id: string; day: string; amount: string }>('sponsored').updateOne({ _id: txHash }, { $setOnInsert: { day, amount } }, { upsert: true });
  }
  async close() { await this.client.close(); }
}
