import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import type { AppProps } from 'next/app';
import { useMemo } from 'react';
import { PeraProvider } from '../contexts/PeraWalletContext';
import '../styles/globals.css';

import '@solana/wallet-adapter-react-ui/styles.css';

export default function App({ Component, pageProps }: AppProps) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || 'http://localhost:8899';
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <PeraProvider>
            <Component {...pageProps} />
          </PeraProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
