export interface BridgeEvent {
  nonce: number;
  chain: 'solana' | 'algorand';
  direction: 'lock' | 'unlock' | 'mint' | 'burn';
  userAddress: string;
  amount: bigint;
  tokenAddress: string;
  timestamp: number;
  timeLock?: number;
  algorandRecipient?: string;
  solanaRecipient?: string;
  status: 'pending' | 'processed' | 'failed';
  counterpartTxId?: string;
}

export interface RelayerConfig {
  solanaRpc: string;
  solanaProgramId: string;
  solanaKeypairPath: string;
  algodUrl: string;
  algodToken: string;
  algoAppId: number;
  algoMnemonic: string;
  dbPath: string;
  port: number;
  adminToken: string;
  pollIntervalMs: number;
}
