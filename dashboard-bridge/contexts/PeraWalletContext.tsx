import { PeraWalletConnect } from '@perawallet/connect';
import { createContext, useContext, useEffect, useState } from 'react';

interface PeraContextValue {
  pera: PeraWalletConnect;
  account: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const PeraContext = createContext<PeraContextValue | null>(null);

export function PeraProvider({ children }: { children: React.ReactNode }) {
  const [pera] = useState(() => new PeraWalletConnect({ chainId: 416001 }));
  const [account, setAccount] = useState<string | null>(null);

  useEffect(() => {
    pera
      .reconnectSession()
      .then((accounts) => {
        if (accounts.length) setAccount(accounts[0]);
      })
      .catch(() => {});
    return () => {
      pera.disconnect().catch(() => {});
    };
  }, [pera]);

  const connect = async () => {
    const accounts = await pera.connect();
    setAccount(accounts[0]);
  };

  const disconnect = async () => {
    await pera.disconnect();
    setAccount(null);
  };

  return (
    <PeraContext.Provider value={{ pera, account, connect, disconnect }}>
      {children}
    </PeraContext.Provider>
  );
}

export function usePera(): PeraContextValue {
  const ctx = useContext(PeraContext);
  if (!ctx) throw new Error('usePera must be used inside PeraProvider');
  return ctx;
}
