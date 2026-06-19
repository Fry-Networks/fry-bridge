# Fry Bridge — Solana ↔ Algorand Lock-and-Mint Bridge

Cross-chain lock-and-mint bridge between Solana (Anchor) and Algorand (PyTeal).

## Architecture

| Component | Technology | Location |
|-----------|------------|----------|
| Solana contract | Anchor 0.30.1 | `anchor/` |
| Algorand contract | PyTeal ARC-4 | `algorand/` |
| Relayer | Node.js + Express | `relayer/` |
| Dashboard | Next.js (stub) | `dashboard-bridge/` |

## Bridge Flows

1. **SOL → fSOL**
   - User calls `lock_sol` on Solana
   - Relayer detects `LockEvent`
   - Relayer calls `mint_fsol` on Algorand

2. **fSOL → SOL**
   - User calls `burn_fsol` on Algorand
   - Relayer detects burn
   - Relayer calls `unlock_sol` on Solana

3. **ASA → wFRY**
   - User calls `deposit_asa` on Algorand
   - Relayer detects deposit
   - Relayer calls `mint_wrapped` on Solana

4. **wFRY → ASA**
   - User calls `burn_wrapped` on Solana
   - Relayer detects burn
   - Relayer calls `release_asa` on Algorand

## Quick Start

### Prerequisites
- Docker
- Node.js 20+
- Python 3 + PyTeal

### Build Solana Program
```bash
cd anchor
# On Windows, use Docker because Anchor symlinks require privileges
docker run --rm -v "$(pwd):/workspace" -w /workspace backpackapp/build:v0.31.0 anchor build --no-idl
```

### Build Algorand Contract
```bash
cd algorand
python contract.py  # generates approval.teal, clear.teal, contract.json
```

### Build Relayer
```bash
cd relayer
npm install
npm run build
npm start
```

### Environment
Copy `relayer/.env.example` to `.env` and fill in RPC endpoints, program/app IDs, and mnemonics.

## Project Structure

```
.
├── anchor/                 # Solana Anchor program
│   └── programs/fry_bridge_solana/src/lib.rs
├── algorand/               # Algorand PyTeal contract
│   └── contract.py
├── relayer/                # Node.js bridge relayer
│   ├── src/
│   │   ├── index.ts        # Entry point
│   │   ├── solana.ts       # Solana watcher + executor
│   │   ├── algorand.ts     # Algorand watcher + executor
│   │   ├── processor.ts    # Event processor
│   │   ├── api.ts          # Admin REST API
│   │   ├── db.ts           # SQLite persistence
│   │   ├── config.ts       # Env config
│   │   └── types.ts        # Shared types
│   ├── Dockerfile
│   └── docker-compose.yml
├── dashboard-bridge/       # Next.js bridge page
│   └── pages/bridge.tsx
├── config/
│   └── tokens.json         # Canonical bridge token mappings
└── scripts/                # Integration test scripts
```

## Admin API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check |
| `GET /status` | No | Stats |
| `GET /events` | No | Event list |
| `GET /events/:nonce` | No | Event by nonce |
| `POST /admin/pause` | Bearer | Pause bridge |
| `POST /admin/unpause` | Bearer | Unpause bridge |

## Notes

- IDL build for Anchor program fails due to `zmij` crate incompatibility with Rust stable in Docker image. Program `.so` compiles successfully with `--no-idl`.
- Dashboard bridge page is a prototype UI stub. Full wallet integration requires operator testing with local wallets.
- Integration tests require running Solana localnet + Algorand sandbox + relayer simultaneously.

## License

MIT — Fry Foundation
