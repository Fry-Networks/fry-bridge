import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { config } from './config';
import { initProcessor, processPendingEvents } from './processor';
import { upsertEvent } from './db';
import apiRoutes from './api';
import * as solana from './solana';
import * as algorand from './algorand';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function main() {
  initProcessor(config.dbPath);
  algorand.initAlgorand();

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: true, credentials: false }));
  app.use(apiRoutes);

  app.listen(config.port, () => {
    console.log(`Relayer API listening on port ${config.port}`);
  });

  // Watchers
  const stopSol = await solana.watchSolana((ev) => {
    console.log('[Solana event]', ev);
    upsertEvent(ev);
  });

  const stopAlgo = await algorand.watchAlgorand((ev) => {
    console.log('[Algorand event]', ev);
    upsertEvent(ev);
  });

  // Processor loop
  const procInterval = setInterval(() => {
    processPendingEvents().catch(console.error);
  }, config.pollIntervalMs);

  console.log('Relayer started');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    stopSol();
    stopAlgo();
    clearInterval(procInterval);
    process.exit(0);
  });
}

main().catch(console.error);
