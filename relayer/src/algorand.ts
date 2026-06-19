import algosdk from 'algosdk';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { BridgeEvent } from './types';

let algod: algosdk.Algodv2;
let sender: algosdk.Account;
let appId: number;

const SELECTORS = {
  deposit_asa: Buffer.from('7e7b100d', 'hex'),
  burn_fsol: Buffer.from('73fd0866', 'hex'),
  mint_fsol: Buffer.from('4336c268', 'hex'),
  release_asa: Buffer.from('a800ca97', 'hex'),
};

export function initAlgorand() {
  const url = new URL(config.algodUrl);
  algod = new algosdk.Algodv2(config.algodToken, url.origin, url.port);
  if (config.algoMnemonic) {
    sender = algosdk.mnemonicToSecretKey(config.algoMnemonic);
  } else {
    console.warn('[Algorand] ALGO_MNEMONIC not set; generating ephemeral account');
    sender = algosdk.generateAccount();
  }
  appId = config.algoAppId;
}

function u64BE(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(v);
  return buf;
}
function pad32(addr: string): Buffer {
  const decoded = algosdk.decodeAddress(addr);
  return Buffer.from(decoded.publicKey);
}
function lockRecordKey(user: string, nonce: bigint): Buffer {
  return Buffer.concat([pad32(user), u64BE(nonce)]);
}

async function getFsolAsaId(): Promise<number> {
  const appInfo = await algod.getApplicationByID(appId).do();
  const gs = (appInfo.params?.['global-state'] || []) as any[];
  const entry = gs.find((s: any) => Buffer.from(s.key, 'base64').toString() === 'fsol_asa_id');
  return entry && entry.value?.uint ? Number(entry.value.uint) : 1105;
}

export async function watchAlgorand(onEvent: (ev: BridgeEvent) => void): Promise<() => void> {
  let lastRound = 0;
  const status = await algod.status().do();
  lastRound = Number(status['last-round']);

  const poll = async () => {
    try {
      const st = await algod.status().do();
      const current = Number(st['last-round']);
      for (let r = lastRound + 1; r <= current; r++) {
        const block = await algod.block(r).do();
        const txs: any[] = block.block?.txns ?? [];
        for (const tx of txs) {
          const txn = tx.txn;
          if (txn?.apid !== appId) continue;
          const appArgs: Uint8Array[] = txn.apaa ?? [];
          if (!appArgs.length) continue;
          const sel = Buffer.from(appArgs[0]);

          function b64buf(v: any): Buffer {
            return typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v);
          }
          if (sel.equals(SELECTORS.deposit_asa)) {
            const asaId = appArgs[1] ? b64buf(appArgs[1]).readBigUInt64BE(0) : 0n;
            const nonce = appArgs[2] ? b64buf(appArgs[2]).readBigUInt64BE(0) : 0n;
            const amount = appArgs[3] ? b64buf(appArgs[3]).readBigUInt64BE(0) : 0n;
            const solanaRecip = appArgs[4] ? new PublicKey(b64buf(appArgs[4]).slice(0, 32)).toBase58() : '';
            onEvent({
              nonce: Number(nonce),
              chain: 'algorand',
              direction: 'lock',
              userAddress: algosdk.encodeAddress(b64buf(txn.snd)),
              algorandRecipient: algosdk.encodeAddress(b64buf(txn.snd)),
              amount,
              tokenAddress: String(asaId),
              solanaRecipient: solanaRecip,
              timestamp: Math.floor(Date.now() / 1000),
              status: 'pending',
              counterpartTxId: '',
            });
          } else if (sel.equals(SELECTORS.burn_fsol)) {
            const nonce = appArgs[1] ? b64buf(appArgs[1]).readBigUInt64BE(0) : 0n;
            const amount = appArgs[2] ? b64buf(appArgs[2]).readBigUInt64BE(0) : 0n;
            const solanaRecip = appArgs[3] ? new PublicKey(b64buf(appArgs[3]).slice(0, 32)).toBase58() : '';
            onEvent({
              nonce: Number(nonce),
              chain: 'algorand',
              direction: 'burn',
              userAddress: algosdk.encodeAddress(b64buf(txn.snd)),
              algorandRecipient: algosdk.encodeAddress(b64buf(txn.snd)),
              amount,
              tokenAddress: '',
              solanaRecipient: solanaRecip,
              timestamp: Math.floor(Date.now() / 1000),
              status: 'pending',
              counterpartTxId: '',
            });
          }
        }
      }
      lastRound = current;
    } catch (e) {
      console.error('[Algorand watcher]', e);
    }
  };

  const interval = setInterval(poll, config.pollIntervalMs);
  return () => clearInterval(interval);
}

export async function executeMintFsol(
  recipient: string,
  nonce: bigint,
  amount: bigint
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  sp.fee = 3000;
  sp.flatFee = true;
  const boxKey = lockRecordKey(recipient, nonce);
  const fsolAsaId = await getFsolAsaId();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    sender: sender.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(sender),
    method: algosdk.ABIMethod.fromSignature('mint_fsol(address,uint64,uint64)void'),
    methodArgs: [recipient, Number(nonce), Number(amount)],
    suggestedParams: sp,
    boxes: [{ appIndex: appId, name: new Uint8Array(boxKey) }],
    appAccounts: [recipient],
    appForeignAssets: [fsolAsaId],
  });
  const result = await atc.execute(algod, 3);
  return result.txIDs[0];
}

export async function executeReleaseAsa(
  recipient: string,
  asaId: bigint,
  nonce: bigint,
  amount: bigint
): Promise<string> {
  const sp = await algod.getTransactionParams().do();
  sp.fee = 3000;
  sp.flatFee = true;
  const boxKey = lockRecordKey(recipient, nonce);
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    sender: sender.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(sender),
    method: algosdk.ABIMethod.fromSignature('release_asa(address,uint64,uint64,uint64)void'),
    methodArgs: [recipient, Number(asaId), Number(nonce), Number(amount)],
    suggestedParams: sp,
    boxes: [{ appIndex: appId, name: new Uint8Array(boxKey) }],
    appAccounts: [recipient],
    appForeignAssets: [Number(asaId)],
  });
  const result = await atc.execute(algod, 3);
  return result.txIDs[0];
}
