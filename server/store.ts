import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Award, Receipt, Treasury } from '../shared/types.js';

export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec([
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS treasuries (id TEXT PRIMARY KEY, data TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS awards (id TEXT PRIMARY KEY, call_hash TEXT UNIQUE, data TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS receipts (tx_hash TEXT NOT NULL, award_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tx_hash, award_id));',
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sponsored (tx_hash TEXT PRIMARY KEY, day TEXT NOT NULL, amount TEXT NOT NULL);',
    ].join('\n'));
  }
  list<T>(table: 'treasuries' | 'awards'): T[] {
    return (this.db.prepare('SELECT data FROM ' + table + ' ORDER BY rowid DESC').all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  treasury(id: string): Treasury | undefined {
    const row = this.db.prepare('SELECT data FROM treasuries WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  award(id: string): Award | undefined {
    const row = this.db.prepare('SELECT data FROM awards WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveTreasury(treasury: Treasury) {
    this.db.prepare('INSERT INTO treasuries (id, data) VALUES (?, ?)').run(treasury.id, JSON.stringify(treasury));
  }
  saveAward(award: Award) {
    this.db.prepare('INSERT INTO awards (id, call_hash, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET call_hash = excluded.call_hash, data = excluded.data')
      .run(award.id, award.callHash ?? null, JSON.stringify(award));
  }
  saveReceipt(receipt: Receipt) {
    this.db.prepare('INSERT OR IGNORE INTO receipts (tx_hash, award_id, data) VALUES (?, ?, ?)').run(receipt.txHash, receipt.awardId, JSON.stringify(receipt));
  }
  receipts(id: string): Receipt[] {
    return (this.db.prepare('SELECT data FROM receipts WHERE award_id = ? ORDER BY rowid').all(id) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  getMeta(key: string) {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  sponsoredToday() {
    const day = new Date().toISOString().slice(0, 10);
    return (this.db.prepare('SELECT amount FROM sponsored WHERE day = ?').all(day) as { amount: string }[]).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  }
  close() { this.db.close(); }
}
