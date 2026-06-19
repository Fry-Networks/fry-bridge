import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { usePera } from '../contexts/PeraWalletContext';
import {
  buildSolanaLockSol,
  buildSolanaBurnWrapped,
  buildAlgorandDepositAsa,
  buildAlgorandBurnFsol,
  submitAlgorandTxns,
  FSOL_ASA,
  FRY2_ASA,
} from '../lib/bridge';

const PAIRS = [
  { id: 'SOL-fSOL', from: 'Solana SOL', to: 'Algorand fSOL', direction: 'solana-lock' },
  { id: 'fSOL-SOL', from: 'Algorand fSOL', to: 'Solana SOL', direction: 'algorand-burn-fs' },
  { id: 'FRY2-wFRY', from: 'Algorand FRY2', to: 'Solana wFRY', direction: 'algorand-deposit' },
  { id: 'wFRY-FRY2', from: 'Solana wFRY', to: 'Algorand FRY2', direction: 'solana-burn' },
];

const RELAYER_URL = process.env.NEXT_PUBLIC_BRIDGE_API_URL || 'http://100.108.101.109:8090';

interface BridgeEvent {
  nonce: number;
  chain: string;
  direction: string;
  userAddress: string;
  amount: string;
  tokenAddress: string;
  status: string;
  counterpartTxId?: string;
  timestamp: number;
}

export default function BridgePage() {
  const [pairId, setPairId] = useState('SOL-fSOL');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [nonce, setNonce] = useState(() => Math.floor(Date.now() / 1000));
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<BridgeEvent[]>([]);
  const [relayerOnline, setRelayerOnline] = useState(false);
  const [wrappedMint, setWrappedMint] = useState('');
  const [wrappedAccount, setWrappedAccount] = useState('');

  const { publicKey, sendTransaction, connected: solConnected } = useWallet();
  const { connection } = useConnection();
  const { account: algoAccount, connect: connectPera, disconnect: disconnectPera, pera } = usePera();

  const pair = PAIRS.find((p) => p.id === pairId)!;

  useEffect(() => {
    checkRelayer();
    const iv = setInterval(() => {
      checkRelayer();
      pollEvents();
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (pair.direction === 'solana-lock' && algoAccount) {
      setRecipient(algoAccount);
    } else if (pair.direction === 'algorand-deposit' && publicKey) {
      setRecipient(publicKey.toBase58());
    } else if (pair.direction === 'algorand-burn-fs' && publicKey) {
      setRecipient(publicKey.toBase58());
    } else if (pair.direction === 'solana-burn' && publicKey) {
      setRecipient(publicKey.toBase58());
    }
  }, [pair.direction, algoAccount, publicKey]);

  async function checkRelayer() {
    try {
      const res = await fetch(`${RELAYER_URL}/health`);
      setRelayerOnline(res.ok);
    } catch {
      setRelayerOnline(false);
    }
  }

  async function pollEvents() {
    try {
      const res = await fetch(`${RELAYER_URL}/events?limit=20`);
      if (!res.ok) return;
      const data = await res.json();
      setHistory((data.events || data || []).slice(0, 20));
    } catch {}
  }

  async function submitBridge() {
    setStatus('');
    const amtNum = Number(amount);
    if (!amtNum || amtNum <= 0) {
      setStatus('Enter a positive amount');
      return;
    }
    if (!recipient) {
      setStatus('Enter a recipient address');
      return;
    }

    const lamportsOrMicro = BigInt(Math.floor(amtNum * 1e9));

    try {
      setStatus('Building transaction...');
      let txId = '';

      if (pair.direction === 'solana-lock') {
        if (!publicKey || !sendTransaction) {
          setStatus('Connect Solana wallet first');
          return;
        }
        const tx = buildSolanaLockSol(publicKey, BigInt(nonce), lamportsOrMicro, recipient);
        txId = await sendTransaction(tx, connection);
        setStatus(`Solana lock submitted: ${txId}`);
      } else if (pair.direction === 'algorand-burn-fs') {
        if (!algoAccount || !pera) {
          setStatus('Connect Algorand wallet first');
          return;
        }
        const [assetTx, appTx] = await buildAlgorandBurnFsol(algoAccount, BigInt(nonce), lamportsOrMicro, recipient);
        const signed = await (pera as any).signTransaction([
          { txn: assetTx },
          { txn: appTx },
        ]);
        txId = await submitAlgorandTxns(signed);
        setStatus(`Algorand burn fSOL submitted: ${txId}`);
      } else if (pair.direction === 'algorand-deposit') {
        if (!algoAccount || !pera) {
          setStatus('Connect Algorand wallet first');
          return;
        }
        const [assetTx, appTx] = await buildAlgorandDepositAsa(
          algoAccount,
          FRY2_ASA,
          BigInt(nonce),
          BigInt(Math.floor(amtNum * 1e6)),
          recipient
        );
        const signed = await (pera as any).signTransaction([
          { txn: assetTx },
          { txn: appTx },
        ]);
        txId = await submitAlgorandTxns(signed);
        setStatus(`Algorand deposit FRY2 submitted: ${txId}`);
      } else if (pair.direction === 'solana-burn') {
        if (!publicKey || !sendTransaction) {
          setStatus('Connect Solana wallet first');
          return;
        }
        if (!wrappedMint || !wrappedAccount) {
          setStatus('Enter wrapped mint and your wrapped token account');
          return;
        }
        const tx = buildSolanaBurnWrapped(
          publicKey,
          BigInt(nonce),
          BigInt(Math.floor(amtNum * 1e6)),
          new PublicKey(wrappedMint),
          new PublicKey(wrappedAccount)
        );
        txId = await sendTransaction(tx, connection);
        setStatus(`Solana burn wrapped submitted: ${txId}`);
      }

      setNonce((n) => n + 1);
    } catch (e: any) {
      setStatus('Error: ' + (e.message || String(e)));
    }
  }

  return (
    <>
      <Head>
        <title>Fry Bridge</title>
      </Head>
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <h1 className="text-3xl font-bold mb-6">Solana ↔ Algorand Bridge</h1>

        <div className="mb-4 flex items-center gap-3">
          <span className={`px-3 py-1 rounded text-sm ${relayerOnline ? 'bg-green-600' : 'bg-red-600'}`}>
            Relayer {relayerOnline ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="max-w-xl bg-gray-800 p-6 rounded-lg shadow space-y-4">
          <div className="flex justify-between">
            <select
              value={pairId}
              onChange={(e) => setPairId(e.target.value)}
              className="bg-gray-700 rounded px-3 py-2"
            >
              {PAIRS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.from} → {p.to}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <WalletMultiButton />
            {solConnected && publicKey && (
              <span className="text-sm text-gray-300">{publicKey.toBase58().slice(0, 8)}...</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {algoAccount ? (
              <>
                <span className="text-sm text-gray-300">{algoAccount.slice(0, 12)}...</span>
                <button onClick={disconnectPera} className="px-3 py-1 bg-red-600 rounded text-sm">
                  Disconnect Pera
                </button>
              </>
            ) : (
              <button onClick={connectPera} className="px-3 py-1 bg-purple-600 rounded text-sm">
                Connect Pera
              </button>
            )}
          </div>

          <div>
            <label className="block text-sm mb-1">Amount</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              type="number"
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder="0.0"
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Recipient ({pair.to})</label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder="Address..."
            />
          </div>

          {pair.direction === 'solana-burn' && (
            <>
              <div>
                <label className="block text-sm mb-1">Wrapped Mint</label>
                <input
                  value={wrappedMint}
                  onChange={(e) => setWrappedMint(e.target.value)}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  placeholder="Solana mint address..."
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Your Wrapped Token Account</label>
                <input
                  value={wrappedAccount}
                  onChange={(e) => setWrappedAccount(e.target.value)}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  placeholder="Token account address..."
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm mb-1">Nonce</label>
            <input
              value={nonce}
              onChange={(e) => setNonce(Number(e.target.value))}
              type="number"
              className="w-full bg-gray-700 rounded px-3 py-2"
            />
          </div>

          <button
            onClick={submitBridge}
            className="w-full bg-blue-600 hover:bg-blue-500 rounded py-2 font-semibold"
          >
            Bridge
          </button>

          {status && <div className="text-sm text-gray-300">{status}</div>}
        </div>

        <div className="max-w-xl mt-8">
          <h2 className="text-xl font-semibold mb-3">Recent Relayer Events</h2>
          {history.length === 0 && <p className="text-gray-400 text-sm">No events yet.</p>}
          <ul className="space-y-2">
            {history.map((h, i) => (
              <li key={i} className="bg-gray-800 p-3 rounded text-sm">
                <div className="flex justify-between">
                  <span>
                    {h.chain} {h.direction} nonce={h.nonce}
                  </span>
                  <span className={`px-2 rounded text-xs ${h.status === 'processed' ? 'bg-green-700' : h.status === 'failed' ? 'bg-red-700' : 'bg-yellow-700'}`}>
                    {h.status}
                  </span>
                </div>
                <div className="text-gray-400 text-xs mt-1">
                  amount={h.amount} token={h.tokenAddress.slice(0, 8)}... user={h.userAddress.slice(0, 8)}...
                  {h.counterpartTxId && <div>tx={h.counterpartTxId.slice(0, 16)}...</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
