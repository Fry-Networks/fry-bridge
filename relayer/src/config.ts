import { RelayerConfig } from './types';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const config: RelayerConfig = {
  solanaRpc: process.env.SOLANA_RPC || 'http://127.0.0.1:8899',
  solanaProgramId: process.env.SOLANA_PROGRAM_ID || '6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz',
  solanaKeypairPath: process.env.SOLANA_KEYPAIR_PATH || '',
  algodUrl: process.env.ALGOD_URL || 'http://127.0.0.1:4001',
  algodToken: process.env.ALGOD_TOKEN || '',
  algoAppId: Number(process.env.ALGO_APP_ID || '0'),
  algoMnemonic: process.env.ALGO_MNEMONIC || '',
  dbPath: process.env.DB_PATH || './relayer.db',
  port: Number(process.env.PORT || '8090'),
  adminToken: requireEnv('RELAYER_ADMIN_TOKEN'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || '5000'),
  fsolAsaId: process.env.FSOL_ASA_ID || '1105',
  fry2AsaId: process.env.FRY2_ASA_ID || '2485314946',
};
