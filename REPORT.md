# Fry Bridge — Build Report

Date: 2026-06-18
Branch: `worktree-fry-bridge`
Commit: `168f084`

## Environment Versions

- Node.js: v24.15.0
- npm: 11.12.1
- Python: 3.14.0
- Docker: 29.5.2
- Git: 2.51.0.windows.2
- Anchor CLI: 0.31.0 (Docker `backpackapp/build:v0.31.0`)
- Rust: 1.96.0 (via Docker)
- Solana CLI: 1.18.26 (host)
- algosdk: 2.9.0
- @solana/web3.js: 1.91.0
- @coral-xyz/anchor: 0.30.1

## Program / App IDs

| Chain | ID | Source |
|-------|----|--------|
| Solana | `6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz` | `Anchor.toml` |
| Algorand | TBD | Requires sandbox deployment |

## Build Artifacts

| Artifact | Size | Lines |
|----------|------|-------|
| `anchor/target/deploy/fry_bridge_solana.so` | 347 KB | binary |
| `algorand/approval.teal` | ~25 KB | 865 lines |
| `algorand/clear.teal` | ~0.5 KB | 2 lines |
| `relayer/dist/*.js` | 8 files | compiled |

## Components Delivered

### Phase 2 — Solana Anchor Program
- File: `anchor/programs/fry_bridge_solana/src/lib.rs`
- Instructions: `initialize`, `set_relayer`, `pause`, `unpause`, `add_token_pair`, `lock_sol`, `lock_spl`, `unlock_sol`, `unlock_spl`, `mint_wrapped`, `burn_wrapped`
- Features: per-tx/hourly/daily rate limits, time locks, pause/unpause, nonce replay protection
- Cross-chain fields: `algorand_recipient` on `LockRecord`, `solana_recipient` parsed from logs
- Status: COMPILED (`.so` generated)

### Phase 3 — Algorand PyTeal Contract
- File: `algorand/contract.py`
- Methods: `initialize`, `set_limits`, `set_relayer`, `pause`, `unpause`, `deposit_asa`, `burn_fsol`, `mint_fsol`, `release_asa`
- Features: global state rate limits, box storage lock records, time locks, pause/unpause
- Cross-chain fields: `solana_recipient` on `deposit_asa`, `burn_fsol`
- Status: COMPILED (`approval.teal`, `clear.teal`, `contract.json`)

### Phase 4 — Node.js Relayer
- Files: `relayer/src/{index,solana,algorand,processor,api,db,config,types}.ts`
- Stack: TypeScript, Express, @solana/web3.js, algosdk, better-sqlite3
- Features:
  - Solana watcher (polls `getSignaturesForAddress`, parses logs)
  - Algorand watcher (polls blocks, scans app transactions)
  - Counterpart executor (unlock/mint on Solana, mint/release on Algorand)
  - SQLite persistence (`processed_events`, `rate_limit_state`)
  - Admin REST API (`/health`, `/status`, `/events`, `/admin/pause`, `/admin/unpause`)
  - Dockerfile + docker-compose.yml for ZEUS00 deployment
- Status: BUILT (`npm run build` passes, 8 JS files in `dist/`)

### Phase 5 — Dashboard Bridge Page
- File: `dashboard-bridge/pages/bridge.tsx`
- Status: STUB (chain selector, amount input, recipient, history list, relayer health indicator)
- Wallet integration: DEFERRED (requires operator testing with real wallets)

## Test Results

| Test Suite | Status | Evidence |
|------------|--------|----------|
| Solana unit tests | DEFERRED | `anchor test` blocked by IDL generation failure |
| Algorand unit tests | DEFERRED | Sandbox deployment not performed |
| Relayer unit tests | DEFERRED | No test runner configured beyond placeholder `jest` |
| Integration tests | DEFERRED | Requires localnet + sandbox + relayer running simultaneously |

## Deferred Items

| Item | Reason | Path Forward |
|------|--------|--------------|
| Anchor IDL generation | `zmij` crate incompatible with Rust stable in Docker image | Use `--no-idl` build; generate IDL manually or wait for upstream fix |
| Anchor `.so` deployment | No localnet running on FryStation | Start `solana-test-validator`, deploy with `anchor deploy` |
| Algorand sandbox deploy | ARES00 algod unreachable from ARES00; ATLAS00 sandbox status unknown | Deploy via ATLAS00 or local `algokit localnet start` |
| Dashboard wallet integration | Operator must test with Phantom/Pera on localnet | Stub exists; wire real adapter after localnet verification |
| Integration tests | All localnets required | Run `scripts/test-integration.ts` once both chains are live |
| ZEUS00 deployment | Operator approval required per CLAUDE.md §17 | Copy relayer Docker image, create `.env`, `docker compose up` |
| HERMES00 dashboard deploy | Operator approval required | Add page to existing Next.js app, rebuild, restart nginx |
| Git push | Operator approval required per plan §Boundary | Local commit only; push deferred to operator review |

## Git Status

```
On branch worktree-fry-bridge
25 files changed, 3327 insertions(+)
Local commit only — NOT pushed to remote
```

## Rollback Commands

```bash
# Revert git commit (keep changes unstaged)
git reset --soft HEAD^

# Revert to pre-build state (delete artifacts)
rm -rf anchor/target/deploy/fry_bridge_solana.so
rm -rf relayer/dist/
rm -rf relayer/node_modules/

# Full project rollback
cd ~
rm -rf ~/fry-bridge/.claude/worktrees/fry-bridge
```

## Known Issues

1. **PyTeal scratch slot bug**: Worked around by using `App.box_create(key, size) > Int(0)` instead of `MaybeValue` for duplicate nonce detection.
2. **Anchor IDL build**: `zmij` crate `hint::select_unpredictable` fails on stable Rust. Program `.so` builds with `--no-idl`.
3. **Relayer Solana `spl_vault` ATA derivation**: Hardcoded in `solana.ts` using `PublicKey.findProgramAddressSync` with `associated` seed. Production should use `getAssociatedTokenAddressSync` from `@solana/spl-token`.
4. **Relayer Algorand `counterpartTxId`**: Set to empty string in event creation because block transaction JSON does not expose a simple txid string in the watcher path.
5. **Dashboard is a stub**: No real wallet signing or contract invocation. Bridge button is a placeholder.

## Next Steps for Operator

1. **Verify localnets**: Start Solana localnet (`solana-test-validator --bind-address 0.0.0.0`) and Algorand sandbox (`algokit localnet start`).
2. **Deploy contracts**: Deploy Solana `.so` and Algorand app, capture program/app IDs.
3. **Configure relayer**: Create `.env` with deployed IDs, funded relayer wallets, and RPC endpoints.
4. **Test end-to-end**: Run `scripts/test-integration.ts` or manual flows.
5. **Push to remote**: Review diff, approve, `git push origin worktree-fry-bridge`.
6. **Deploy infra**: Copy relayer to ZEUS00, dashboard page to HERMES00.

---
Generated by Claude Code (Opus 4.6) on FryStation
