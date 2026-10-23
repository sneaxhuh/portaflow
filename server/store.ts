import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Award, Receipt, Treasury, PayoutRound, LedgerEntry } from '../shared/types.js';

export type Challenge = { id: string; address: string; message: string; expires: number };
export type Session = { address: string; expires: number };
export interface DataStore {
  list<T>(table: 'treasuries' | 'awards' | 'rounds'): Promise<T[]>;
  treasury(id: string): Promise<Treasury | undefined>;
  award(id: string): Promise<Award | undefined>;
  saveTreasury(treasury: Treasury): Promise<void>;
  saveAward(award: Award): Promise<void>;
  saveAwards(awards: Award[]): Promise<void>;
  round(id: string): Promise<PayoutRound | undefined>;
  saveRound(round: PayoutRound): Promise<void>;
  saveLedger(entry: LedgerEntry): Promise<void>;
  ledger(treasuryId: string): Promise<LedgerEntry[]>;
  saveReceipt(receipt: Receipt): Promise<void>;
  receipts(id: string): Promise<Receipt[]>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  saveChallenge(challenge: Challenge): Promise<void>;
  challenge(id: string): Promise<Challenge | undefined>;
  consumeChallenge(id: string): Promise<boolean>;
  saveSession(hash: string, session: Session): Promise<void>;
  session(hash: string): Promise<Session | undefined>;
  deleteSession(hash: string): Promise<void>;
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<void>;
  sponsoredToday(): Promise<bigint>;
  reserveSponsored(txHash: string, day: string, amount: string): Promise<void>;
  close(): Promise<void>;
}

export class Store implements DataStore {
  db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec([
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS treasuries (id TEXT PRIMARY KEY, data TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS awards (id TEXT PRIMARY KEY, call_hash TEXT UNIQUE, data TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, call_hash TEXT UNIQUE, data TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, treasury_id TEXT NOT NULL, block_number INTEGER NOT NULL, data TEXT NOT NULL);',
      'CREATE INDEX IF NOT EXISTS ledger_treasury ON ledger(treasury_id, block_number);',
      'CREATE TABLE IF NOT EXISTS receipts (tx_hash TEXT NOT NULL, award_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tx_hash, award_id));',
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sponsored (tx_hash TEXT PRIMARY KEY, day TEXT NOT NULL, amount TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);',
    ].join('\n'));
  }
  async list<T>(table: 'treasuries' | 'awards' | 'rounds'): Promise<T[]> {
    return (this.db.prepare('SELECT data FROM ' + table + ' ORDER BY rowid DESC').all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  async treasury(id: string): Promise<Treasury | undefined> {
    const row = this.db.prepare('SELECT data FROM treasuries WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  async award(id: string): Promise<Award | undefined> {
    const row = this.db.prepare('SELECT data FROM awards WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  async saveTreasury(treasury: Treasury) {
    this.db.prepare('INSERT INTO treasuries (id, data) VALUES (?, ?)').run(treasury.id, JSON.stringify(treasury));
  }
  async saveAward(award: Award) {
    this.db.prepare('INSERT INTO awards (id, call_hash, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET call_hash = excluded.call_hash, data = excluded.data')
      .run(award.id, award.callHash ?? null, JSON.stringify(award));
  }
  async saveAwards(awards: Award[]) {
    this.db.exec('BEGIN');
    try {
      for (const award of awards) await this.saveAward(award);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async saveReceipt(receipt: Receipt) {
    this.db.prepare('INSERT OR IGNORE INTO receipts (tx_hash, award_id, data) VALUES (?, ?, ?)').run(receipt.txHash, receipt.awardId, JSON.stringify(receipt));
  }
  async round(id: string): Promise<PayoutRound | undefined> {
    const row = this.db.prepare('SELECT data FROM rounds WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  async saveRound(round: PayoutRound) {
    this.db.prepare('INSERT INTO rounds (id, call_hash, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET call_hash = excluded.call_hash, data = excluded.data')
      .run(round.id, round.callHash ?? null, JSON.stringify(round));
  }
  async saveLedger(entry: LedgerEntry) {
    this.db.prepare('INSERT OR IGNORE INTO ledger VALUES (?, ?, ?, ?)').run(entry.id, entry.treasuryId, entry.blockNumber, JSON.stringify(entry));
  }
  async ledger(treasuryId: string): Promise<LedgerEntry[]> {
    return (this.db.prepare('SELECT data FROM ledger WHERE treasury_id = ? ORDER BY block_number DESC, id DESC LIMIT 500').all(treasuryId) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  async receipts(id: string): Promise<Receipt[]> {
    return (this.db.prepare('SELECT data FROM receipts WHERE award_id = ? ORDER BY rowid').all(id) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  async getMeta(key: string) {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  async setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  async saveChallenge(challenge: Challenge) {
    this.db.prepare('DELETE FROM challenges WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO challenges VALUES (?, ?, ?, ?)').run(challenge.id, challenge.address, challenge.message, challenge.expires);
  }
  async challenge(id: string) {
    return this.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as Challenge | undefined;
  }
  async consumeChallenge(id: string) {
    return this.db.prepare('DELETE FROM challenges WHERE id = ? AND expires > ?').run(id, Date.now()).changes === 1;
  }
  async saveSession(hash: string, session: Session) {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, session.address, session.expires);
  }
  async session(hash: string) {
    return this.db.prepare('SELECT address, expires FROM sessions WHERE hash = ? AND expires > ?').get(hash, Date.now()) as Session | undefined;
  }
  async deleteSession(hash: string) { this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash); }
  async acquireLease(key: string, owner: string, ttlMs: number) {
    return this.db.prepare('INSERT INTO leases VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE leases.expires <= ? OR leases.owner = ?')
      .run(key, owner, Date.now() + ttlMs, Date.now(), owner).changes === 1;
  }
  async releaseLease(key: string, owner: string) { this.db.prepare('DELETE FROM leases WHERE key = ? AND owner = ?').run(key, owner); }
  async sponsoredToday() {
    const day = new Date().toISOString().slice(0, 10);
    return (this.db.prepare('SELECT amount FROM sponsored WHERE day = ?').all(day) as { amount: string }[]).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  }
  async reserveSponsored(txHash: string, day: string, amount: string) {
    this.db.prepare('INSERT OR IGNORE INTO sponsored VALUES (?, ?, ?)').run(txHash, day, amount);
  }
  async close() { this.db.close(); }
}

export async function createStore(): Promise<DataStore> {
  if (process.env.MONGODB_URI) {
    const { MongoStore } = await import('./mongo-store.js');
    return MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'portaflow');
  }
  if (process.env.VERCEL) throw new Error('Set MONGODB_URI in the Vercel project environment before deploying PortaFlow.');
  return new Store(process.env.PORTAFLOW_DB || '.portaflow/portaflow.sqlite');
}
