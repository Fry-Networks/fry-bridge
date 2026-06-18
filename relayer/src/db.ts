import Database from 'better-sqlite3';
import { BridgeEvent } from './types';

let db: Database.Database;

export function initDb(path: string): Database.Database {
  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce INTEGER NOT NULL,
      chain TEXT NOT NULL,
      direction TEXT NOT NULL,
      userAddress TEXT NOT NULL,
      amount TEXT NOT NULL,
      tokenAddress TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      timeLock INTEGER,
      status TEXT NOT NULL,
      counterpartTxId TEXT,
      UNIQUE(nonce, chain, direction, userAddress)
    );
    CREATE INDEX IF NOT EXISTS idx_events_nonce ON processed_events(nonce);
    CREATE INDEX IF NOT EXISTS idx_events_chain ON processed_events(chain);
    CREATE INDEX IF NOT EXISTS idx_events_status ON processed_events(status);

    CREATE TABLE IF NOT EXISTS rate_limit_state (
      chain TEXT PRIMARY KEY,
      hourlyVolume TEXT NOT NULL,
      hourlyPeriodStart INTEGER NOT NULL,
      dailyVolume TEXT NOT NULL,
      dailyPeriodStart INTEGER NOT NULL
    );
  `);
  return db;
}

export function upsertEvent(ev: BridgeEvent): void {
  const stmt = db.prepare(`
    INSERT INTO processed_events
      (nonce, chain, direction, userAddress, amount, tokenAddress, timestamp, timeLock, status, counterpartTxId)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nonce, chain, direction, userAddress)
    DO UPDATE SET
      status = excluded.status,
      counterpartTxId = excluded.counterpartTxId,
      timeLock = excluded.timeLock
  `);
  stmt.run(
    ev.nonce,
    ev.chain,
    ev.direction,
    ev.userAddress,
    String(ev.amount),
    ev.tokenAddress,
    ev.timestamp,
    ev.timeLock ?? null,
    ev.status,
    ev.counterpartTxId ?? null
  );
}

export function getEvents(limit = 100): BridgeEvent[] {
  const rows = db.prepare(
    'SELECT * FROM processed_events ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(toBridgeEvent);
}

export function getEventByNonce(nonce: number): BridgeEvent | undefined {
  const row = db.prepare(
    'SELECT * FROM processed_events WHERE nonce = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(nonce) as any;
  return row ? toBridgeEvent(row) : undefined;
}

export function getPendingEvents(): BridgeEvent[] {
  const rows = db.prepare(
    "SELECT * FROM processed_events WHERE status = 'pending' ORDER BY timestamp ASC"
  ).all() as any[];
  return rows.map(toBridgeEvent);
}

function toBridgeEvent(row: any): BridgeEvent {
  return {
    nonce: row.nonce,
    chain: row.chain,
    direction: row.direction,
    userAddress: row.userAddress,
    amount: BigInt(row.amount),
    tokenAddress: row.tokenAddress,
    timestamp: row.timestamp,
    timeLock: row.timeLock ?? undefined,
    status: row.status,
    counterpartTxId: row.counterpartTxId ?? undefined,
  };
}

export { db };
