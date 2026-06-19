import { PublicKey } from '@solana/web3.js';
import algosdk from 'algosdk';
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
    const algoRecip = ev.algorandRecipient || algosdk.encodeAddress(new PublicKey(ev.userAddress).toBytes());
    if (ev.tokenAddress === SOL_MINT || ev.tokenAddress === '' || ev.tokenAddress === '11111111111111111111111111111111') {
      return await algorand.executeMintFsol(algoRecip, BigInt(ev.nonce), ev.amount);
    }
    const asaId = BigInt(2485314946); // prototype mapping
    return await algorand.executeReleaseAsa(algoRecip, asaId, BigInt(ev.nonce), ev.amount);
  }

  if (ev.chain === 'solana' && ev.direction === 'burn') {
    const recip = ev.userAddress;
    const asaId = BigInt(2485314946);
    return await algorand.executeReleaseAsa(recip, asaId, BigInt(ev.nonce), ev.amount);
  }

  if (ev.chain === 'algorand' && ev.direction === 'lock') {
    const asaId = BigInt(ev.tokenAddress);
    if (asaId === 1105n) {
      throw new Error('Unsupported: fSOL has no Solana wrapped mint in prototype');
    }
    const fry2SolanaMint = process.env.FRY2_SOLANA_MINT;
    if (!fry2SolanaMint) {
      throw new Error('Unsupported: FRY2_SOLANA_MINT not configured');
    }
    if (!ev.solanaRecipient) {
      throw new Error('Unsupported: Algorand lock event missing solanaRecipient');
    }
    return await solana.executeMintWrapped(
      BigInt(ev.nonce),
      ev.amount,
      new PublicKey(fry2SolanaMint),
      new PublicKey(ev.solanaRecipient)
    );
  }

  if (ev.chain === 'algorand' && ev.direction === 'burn') {
    const recipRaw = ev.solanaRecipient || ev.userAddress;
    const recip = new PublicKey(recipRaw);
    return await solana.executeUnlockSol(BigInt(ev.nonce), ev.amount, recip, recip);
  }

  return undefined;
}
