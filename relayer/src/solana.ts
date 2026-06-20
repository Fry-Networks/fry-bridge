import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import algosdk from 'algosdk';
import * as fs from 'fs';
import { config } from './config';
import { BridgeEvent } from './types';

const PROGRAM_ID = new PublicKey(config.solanaProgramId);
const RELAYER_KP = config.solanaKeypairPath
  ? Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(config.solanaKeypairPath, 'utf-8')))
    )
  : Keypair.generate();

export const connection = new Connection(config.solanaRpc, 'confirmed');

// Discriminators (first 8 bytes of SHA256 of `global:<name>`)
const EVENT_DISC = {
  LockEvent: Buffer.from([76, 37, 6, 186, 14, 42, 253, 15]),
  BurnEvent: Buffer.from([33, 89, 47, 117, 82, 124, 238, 250]),
};

function parseAnchorEvent(logs: string[]): { name: string; data: Buffer } | undefined {
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    try {
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length < 8) continue;
      const disc = buf.slice(0, 8);
      if (disc.equals(EVENT_DISC.LockEvent)) {
        return { name: 'LockEvent', data: buf.slice(8) };
      }
      if (disc.equals(EVENT_DISC.BurnEvent)) {
        return { name: 'BurnEvent', data: buf.slice(8) };
      }
    } catch {}
  }
  return undefined;
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.slice(offset, offset + 32)).toBase58();
}
function readAlgorandAddress(buf: Buffer, offset: number): string {
  return algosdk.encodeAddress(buf.slice(offset, offset + 32));
}
function readU64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}
function readI64(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

const DISC = {
  lock_sol: Buffer.from([181,15,15,99,159,87,241,42]),
  lock_spl: Buffer.from([57,242,157,133,111,4,8,242]),
  burn_wrapped: Buffer.from([108,204,222,174,207,5,73,194]),
  unlock_sol: Buffer.from([216,43,22,34,242,159,14,34]),
  unlock_spl: Buffer.from([52,174,149,148,187,53,29,90]),
  mint_wrapped: Buffer.from([130,90,18,116,188,64,204,199]),
};

function u64LE(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

function findBridgeStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('bridge_state')], PROGRAM_ID);
}
function findSolVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('sol_vault')], PROGRAM_ID);
}
function findWrappedMintPda(originalMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('wrapped_mint'), originalMint.toBuffer()],
    PROGRAM_ID
  );
}
function findLockRecordPda(user: PublicKey, nonce: bigint): [PublicKey, number] {
  const n = u64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lock_record'), user.toBuffer(), n],
    PROGRAM_ID
  );
}
function findUserStatePda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_state'), user.toBuffer()],
    PROGRAM_ID
  );
}

async function buildAndSend(tx: Transaction): Promise<string> {
  tx.feePayer = RELAYER_KP.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(connection, tx, [RELAYER_KP]);
}

export async function watchSolana(onEvent: (ev: BridgeEvent) => void): Promise<() => void> {
  let lastSig = '';
  const poll = async () => {
    try {
      const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 10 });
      let pastLast = !lastSig;
      for (const s of sigs.slice().reverse()) {
        if (s.signature === lastSig) { pastLast = true; continue; }
        if (!pastLast) continue;
        const tx = await connection.getTransaction(s.signature, { commitment: 'confirmed' });
        if (!tx?.meta?.logMessages) continue;
        const evt = parseAnchorEvent(tx.meta.logMessages);
        if (!evt) continue;
        if (evt.name === 'LockEvent') {
          const d = evt.data;
          const user = readPubkey(d, 0);
          const recip = readAlgorandAddress(d, 32);
          const amount = readU64(d, 64);
          const tokenMint = readPubkey(d, 72);
          const nonce = readU64(d, 104);
          const ts = Number(readI64(d, 112));
          onEvent({
            nonce: Number(nonce),
            chain: 'solana',
            direction: 'lock',
            userAddress: user,
            amount,
            tokenAddress: tokenMint,
            algorandRecipient: recip,
            timestamp: ts,
            status: 'pending',
            counterpartTxId: s.signature,
          });
        } else if (evt.name === 'BurnEvent') {
          const d = evt.data;
          const nonce = readU64(d, 0);
          const user = readPubkey(d, 8);
          const amount = readU64(d, 40);
          const wrappedMint = readPubkey(d, 48);
          onEvent({
            nonce: Number(nonce),
            chain: 'solana',
            direction: 'burn',
            userAddress: user,
            amount,
            tokenAddress: wrappedMint,
            timestamp: Math.floor(Date.now() / 1000),
            status: 'pending',
            counterpartTxId: s.signature,
          });
        }
      }
      if (sigs.length) lastSig = sigs[0].signature;
    } catch (e) {
      console.error('[Solana watcher]', e);
    }
  };
  const interval = setInterval(poll, config.pollIntervalMs);
  await poll();
  return () => clearInterval(interval);
}

export async function executeUnlockSol(
  nonce: bigint,
  amount: bigint,
  recipient: PublicKey,
  lockRecordUser: PublicKey
): Promise<string> {
  const [bridgeState] = findBridgeStatePda();
  const [solVault] = findSolVaultPda();
  const [lockRecord] = findLockRecordPda(lockRecordUser, nonce);

  const keys = [
    { pubkey: RELAYER_KP.publicKey, isSigner: true, isWritable: false },
    { pubkey: bridgeState, isSigner: false, isWritable: false },
    { pubkey: solVault, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: lockRecordUser, isSigner: false, isWritable: false },
    { pubkey: lockRecord, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const data = Buffer.concat([DISC.unlock_sol, u64LE(nonce), u64LE(amount)]);
  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);
  return buildAndSend(tx);
}

export async function executeUnlockSpl(
  nonce: bigint,
  amount: bigint,
  originalMint: PublicKey,
  recipientTokenAccount: PublicKey,
  lockRecordUser: PublicKey
): Promise<string> {
  const [bridgeState] = findBridgeStatePda();
  const [splVault] = PublicKey.findProgramAddressSync(
    [originalMint.toBuffer(), bridgeState.toBuffer(), Buffer.from('associated')],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  );
  const [lockRecord] = findLockRecordPda(lockRecordUser, nonce);

  const keys = [
    { pubkey: RELAYER_KP.publicKey, isSigner: true, isWritable: false },
    { pubkey: bridgeState, isSigner: false, isWritable: true },
    { pubkey: originalMint, isSigner: false, isWritable: false },
    { pubkey: splVault, isSigner: false, isWritable: true },
    { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: lockRecordUser, isSigner: false, isWritable: false },
    { pubkey: lockRecord, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
  ];

  const data = Buffer.concat([DISC.unlock_spl, u64LE(nonce), u64LE(amount)]);
  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);
  return buildAndSend(tx);
}

export async function executeMintWrapped(
  nonce: bigint,
  amount: bigint,
  originalMint: PublicKey,
  recipientTokenAccount: PublicKey
): Promise<string> {
  const [bridgeState] = findBridgeStatePda();
  const [wrappedMint] = findWrappedMintPda(originalMint);

  const keys = [
    { pubkey: RELAYER_KP.publicKey, isSigner: true, isWritable: false },
    { pubkey: bridgeState, isSigner: false, isWritable: true },
    { pubkey: originalMint, isSigner: false, isWritable: false },
    { pubkey: wrappedMint, isSigner: false, isWritable: true },
    { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
  ];

  const data = Buffer.concat([DISC.mint_wrapped, u64LE(nonce), u64LE(amount)]);
  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);
  return buildAndSend(tx);
}
