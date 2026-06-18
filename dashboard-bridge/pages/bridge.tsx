import React, { useState, useEffect } from 'react';
import Head from 'next/head';

interface ChainConfig {
  name: string;
  symbol: string;
  rpc: string;
  walletLib: string;
}

const CHAINS: Record<string, ChainConfig> = {
  solana: { name: 'Solana', symbol: 'SOL', rpc: 'http://127.0.0.1:8899', walletLib: '@solana/wallet-adapter-react' },
  algorand: { name: 'Algorand', symbol: 'FRY', rpc: 'http://127.0.0.1:4001', walletLib: '@perawallet/connect' },
};

export default function BridgePage() {
  const [fromChain, setFromChain] = useState('solana');
  const [toChain, setToChain] = useState('algorand');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [relayerOnline, setRelayerOnline] = useState(false);

  useEffect(() => {
    checkRelayer();
    const iv = setInterval(checkRelayer, 10000);
    return () => clearInterval(iv);
  }, []);

  async function checkRelayer() {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BRIDGE_API_URL || 'http://localhost:8090'}/health`);
      setRelayerOnline(res.ok);
    } catch {
      setRelayerOnline(false);
    }
  }

  async function submitBridge() {
    setStatus('Processing...');
    try {
      // TODO: wire real wallet + contract calls
      setStatus(`Sent ${amount} ${CHAINS[fromChain].symbol} to ${recipient}`);
      setHistory(prev => [{ from: fromChain, to: toChain, amount, recipient, ts: Date.now() }, ...prev]);
    } catch (e: any) {
      setStatus('Error: ' + e.message);
    }
  }

  return (
    <>
      <Head><title>Fry Bridge</title></Head>
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <h1 className="text-3xl font-bold mb-6">Solana ↔ Algorand Bridge</h1>

        <div className="mb-4 flex items-center gap-3">
          <span className={`px-3 py-1 rounded text-sm ${relayerOnline ? 'bg-green-600' : 'bg-red-600'}`}>
            Relayer {relayerOnline ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="max-w-xl bg-gray-800 p-6 rounded-lg shadow">
          <div className="flex justify-between mb-4">
            <select value={fromChain} onChange={e => { setFromChain(e.target.value); setToChain(e.target.value === 'solana' ? 'algorand' : 'solana'); }} className="bg-gray-700 rounded px-3 py-2">
              <option value="solana">Solana</option>
              <option value="algorand">Algorand</option>
            </select>
            <span className="self-center">→</span>
            <select value={toChain} disabled className="bg-gray-700 rounded px-3 py-2 opacity-60">
              <option value="algorand">Algorand</option>
              <option value="solana">Solana</option>
            </select>
          </div>

          <div className="mb-4">
            <label className="block text-sm mb-1">Amount</label>
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" className="w-full bg-gray-700 rounded px-3 py-2" placeholder="0.0" />
          </div>

          <div className="mb-4">
            <label className="block text-sm mb-1">Recipient ({toChain} address)</label>
            <input value={recipient} onChange={e => setRecipient(e.target.value)} className="w-full bg-gray-700 rounded px-3 py-2" placeholder="Address..." />
          </div>

          <button onClick={submitBridge} className="w-full bg-blue-600 hover:bg-blue-500 rounded py-2 font-semibold">Bridge</button>

          {status && <div className="mt-4 text-sm text-gray-300">{status}</div>}
        </div>

        <div className="max-w-xl mt-8">
          <h2 className="text-xl font-semibold mb-3">Recent History</h2>
          {history.length === 0 && <p className="text-gray-400 text-sm">No transactions yet.</p>}
          <ul className="space-y-2">
            {history.map((h, i) => (
              <li key={i} className="bg-gray-800 p-3 rounded text-sm">
                {h.from} → {h.to}: {h.amount} to {h.recipient.slice(0, 8)}...
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
