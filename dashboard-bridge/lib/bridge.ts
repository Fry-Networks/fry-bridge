import algosdk from 'algosdk';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

// ── Solana config ────────────────────────────────────────────────────────
const SOLANA_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID ||
    '6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz'
);

const DISC = {
  lock_sol: Buffer.from([181, 15, 15, 99, 159, 87, 241, 42]),
  burn_wrapped: Buffer.from([108, 204, 222, 174, 207, 5, 73, 194]),
};

function findSolPda(seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, SOLANA_PROGRAM_ID);
}

function u64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

export function buildSolanaLockSol(
  signer: PublicKey,
  nonce: bigint,
  amount: bigint,
  algoRecipient: string
): Transaction {
  const [bridgeState] = findSolPda([Buffer.from('bridge_state')]);
  const [solVault] = findSolPda([Buffer.from('sol_vault')]);
  const [userState] = findSolPda([
    Buffer.from('user_state'),
    signer.toBuffer(),
  ]);
  const [lockRecord] = findSolPda([
    Buffer.from('lock_record'),
    signer.toBuffer(),
    u64LE(nonce),
  ]);

  const algoPk = algosdk.decodeAddress(algoRecipient).publicKey;
  const data = Buffer.concat([
    DISC.lock_sol,
    u64LE(nonce),
    u64LE(amount),
    Buffer.from(algoPk),
  ]);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: bridgeState, isSigner: false, isWritable: true },
      { pubkey: solVault, isSigner: false, isWritable: true },
      { pubkey: userState, isSigner: false, isWritable: true },
      { pubkey: lockRecord, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SOLANA_PROGRAM_ID,
    data,
  });

  return new Transaction().add(ix);
}

export function buildSolanaBurnWrapped(
  signer: PublicKey,
  nonce: bigint,
  amount: bigint,
  wrappedMint: PublicKey,
  userWrappedAccount: PublicKey
): Transaction {
  const [bridgeState] = findSolPda([Buffer.from('bridge_state')]);
  const data = Buffer.concat([DISC.burn_wrapped, u64LE(nonce), u64LE(amount)]);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: bridgeState, isSigner: false, isWritable: false },
      { pubkey: wrappedMint, isSigner: false, isWritable: true },
      { pubkey: userWrappedAccount, isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        isSigner: false,
        isWritable: false,
      },
    ],
    programId: SOLANA_PROGRAM_ID,
    data,
  });

  return new Transaction().add(ix);
}

// ── Algorand config ──────────────────────────────────────────────────────
const ALGO_APP_ID = Number(process.env.NEXT_PUBLIC_ALGO_APP_ID || '0');
const ALGOD_URL = process.env.NEXT_PUBLIC_ALGOD_URL || 'http://localhost:4001';
const ALGOD_TOKEN = process.env.NEXT_PUBLIC_ALGOD_TOKEN || '';

const _algodUrl = new URL(ALGOD_URL);
const algod = new algosdk.Algodv2(
  ALGOD_TOKEN,
  _algodUrl.origin,
  _algodUrl.port
);

const SELECTORS = {
  deposit_asa: Buffer.from('7e7b100d', 'hex'),
  burn_fsol: Buffer.from('73fd0866', 'hex'),
};

const FSOL_ASA = 1105;
const FRY2_ASA = 1113;

function u64BE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
}

function lockRecordKey(user: string, nonce: bigint): Buffer {
  return Buffer.concat([
    Buffer.from(algosdk.decodeAddress(user).publicKey),
    u64BE(nonce),
  ]);
}

export async function buildAlgorandDepositAsa(
  sender: string,
  asaId: number,
  nonce: bigint,
  amount: bigint,
  solanaRecipient: string
): Promise<algosdk.Transaction[]> {
  const sp = await algod.getTransactionParams().do();
  sp.fee = 3000;
  sp.flatFee = true;

  const solRecipBytes = new PublicKey(solanaRecipient).toBytes();
  const boxKey = lockRecordKey(sender, nonce);

  const assetTx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: sender,
    to: algosdk.getApplicationAddress(ALGO_APP_ID),
    amount: Number(amount),
    assetIndex: asaId,
    suggestedParams: sp,
  });

  const appTx = algosdk.makeApplicationNoOpTxnFromObject({
    from: sender,
    suggestedParams: sp,
    appIndex: ALGO_APP_ID,
    appArgs: [
      SELECTORS.deposit_asa,
      algosdk.encodeUint64(asaId),
      algosdk.encodeUint64(Number(nonce)),
      algosdk.encodeUint64(Number(amount)),
      solRecipBytes,
    ],
    boxes: [{ appIndex: ALGO_APP_ID, name: new Uint8Array(boxKey) }],
    foreignAssets: [asaId],
  });

  algosdk.assignGroupID([assetTx, appTx]);
  return [assetTx, appTx];
}

export async function buildAlgorandBurnFsol(
  sender: string,
  nonce: bigint,
  amount: bigint,
  solanaRecipient: string
): Promise<algosdk.Transaction[]> {
  const sp = await algod.getTransactionParams().do();
  sp.fee = 3000;
  sp.flatFee = true;

  const solRecipBytes = new PublicKey(solanaRecipient).toBytes();
  const boxKey = lockRecordKey(sender, nonce);

  const assetTx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: sender,
    to: algosdk.getApplicationAddress(ALGO_APP_ID),
    amount: Number(amount),
    assetIndex: FSOL_ASA,
    suggestedParams: sp,
  });

  const appTx = algosdk.makeApplicationNoOpTxnFromObject({
    from: sender,
    suggestedParams: sp,
    appIndex: ALGO_APP_ID,
    appArgs: [
      SELECTORS.burn_fsol,
      algosdk.encodeUint64(Number(nonce)),
      algosdk.encodeUint64(Number(amount)),
      solRecipBytes,
    ],
    boxes: [{ appIndex: ALGO_APP_ID, name: new Uint8Array(boxKey) }],
    foreignAssets: [FSOL_ASA],
  });

  algosdk.assignGroupID([assetTx, appTx]);
  return [assetTx, appTx];
}

export async function submitAlgorandTxns(
  signed: Uint8Array[]
): Promise<string> {
  const { txId } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txId, 10);
  return txId;
}

export { algod, FSOL_ASA, FRY2_ASA };
