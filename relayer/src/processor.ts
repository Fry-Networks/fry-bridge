import { PublicKey } from '@solana/web3.js';
import { initDb, upsertEvent, getPendingEvents } from './db';
import { config } from './config';
import { BridgeEvent } from './types';
import * as solana from './solana';
import * as algorand from './algorand';

let paused = false;
export function setPaused(p: boolean) { paused = p; }
export function isPaused(): boolean { return paused; }

export function initProcessor(dbPath: string) { initDb(dbPath); }

export async function processPendingEvents() {
  if (paused) return;
  for (const ev of getPendingEvents()) {
    try {
      const counterpartTx = await executeCounterpart(ev);
      if (counterpartTx) {
        upsertEvent({ ...ev, status: 'processed', counterpartTxId: counterpartTx });
      }
    } catch (e: any) {
      console.error('[Processor] failed for event', ev.nonce, e.message);
      upsertEvent({ ...ev, status: 'failed' });
    }
  }
}

async function executeCounterpart(ev: BridgeEvent): Promise<string | undefined> {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  if (ev.chain === 'solana' && ev.direction === 'lock') {
    const recip = ev.userAddress; // prototype: treat user as recipient
    if (ev.tokenAddress === SOL_MINT || ev.tokenAddress === '') {
      return await algorand.executeMintFsol(recip, BigInt(ev.nonce), ev.amount);
    }
    const asaId = BigInt(2485314946); // prototype mapping
    return await algorand.executeReleaseAsa(recip, asaId, BigInt(ev.nonce), ev.amount);
  }

  if (ev.chain === 'solana' && ev.direction === 'burn') {
    const recip = ev.userAddress;
    const asaId = BigInt(2485314946);
    return await algorand.executeReleaseAsa(recip, asaId, BigInt(ev.nonce), ev.amount);
  }

  if (ev.chain === 'algorand' && ev.direction === 'lock') {
    const mint = new PublicKey('FRY2MintPlaceholder');
    const recip = new PublicKey(ev.userAddress);
    // NOTE: production must derive or create ATA for recip
    return await solana.executeMintWrapped(BigInt(ev.nonce), ev.amount, mint, recip);
  }

  if (ev.chain === 'algorand' && ev.direction === 'burn') {
    const recip = new PublicKey(ev.userAddress);
    return await solana.executeUnlockSol(BigInt(ev.nonce), ev.amount, recip, recip);
  }

  return undefined;
}
