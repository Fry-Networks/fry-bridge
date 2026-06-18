import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
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

export async function watchSolana(onEvent: (ev: BridgeEvent) => void): Promise<() => void> {
  let lastSig = '';
  const poll = async () => {
    try {
      const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 10 });
      for (const s of sigs.slice().reverse()) {
        if (s.signature === lastSig) continue;
        const tx = await connection.getTransaction(s.signature, { commitment: 'confirmed' });
        if (!tx?.meta?.logMessages) continue;
        const logs = tx.meta.logMessages.join('\n');
        if (logs.includes('LockEvent')) {
          const lockMatch = logs.match(/LockEvent\s*\{[^}]*user:\s*(\S+)/);
          const user = lockMatch ? lockMatch[1] : tx.transaction.message.accountKeys[0].toBase58();
          const amountMatch = logs.match(/amount:\s*(\d+)/);
          const nonceMatch = logs.match(/nonce:\s*(\d+)/);
          const tokenMatch = logs.match(/token_mint:\s*(\S+)/);
          const recipMatch = logs.match(/algorand_recipient:\s*(\S+)/);
          onEvent({
            nonce: Number(nonceMatch?.[1] ?? '0'),
            chain: 'solana',
            direction: 'lock',
            userAddress: user,
            amount: BigInt(amountMatch?.[1] ?? '0'),
            tokenAddress: tokenMatch?.[1] ?? '',
            timestamp: Math.floor(Date.now() / 1000),
            status: 'pending',
            counterpartTxId: s.signature,
          });
        } else if (logs.includes('BurnEvent')) {
          const userMatch = logs.match(/user:\s*(\S+)/);
          const amountMatch = logs.match(/amount:\s*(\d+)/);
          const nonceMatch = logs.match(/nonce:\s*(\d+)/);
          const mintMatch = logs.match(/wrapped_mint:\s*(\S+)/);
          onEvent({
            nonce: Number(nonceMatch?.[1] ?? '0'),
            chain: 'solana',
            direction: 'burn',
            userAddress: userMatch?.[1] ?? '',
            amount: BigInt(amountMatch?.[1] ?? '0'),
            tokenAddress: mintMatch?.[1] ?? '',
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
  return await sendAndConfirmTransaction(connection, tx, [RELAYER_KP]);
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
  return await sendAndConfirmTransaction(connection, tx, [RELAYER_KP]);
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
  return await sendAndConfirmTransaction(connection, tx, [RELAYER_KP]);
}
