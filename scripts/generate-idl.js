const crypto = require('crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

function disc8(input) {
  return Array.from(sha256(input).slice(0, 8));
}

// Verify known discriminators from relayer
const known = {
  'global:lock_sol': [181,15,15,99,159,87,241,42],
  'global:lock_spl': [57,242,157,133,111,4,8,242],
  'global:burn_wrapped': [108,204,222,174,207,5,73,194],
  'global:unlock_sol': [216,43,22,34,242,159,14,34],
  'global:unlock_spl': [52,174,149,148,187,53,29,90],
  'global:mint_wrapped': [130,90,18,116,188,64,204,199],
};

for (const [name, expected] of Object.entries(known)) {
  const actual = disc8(name);
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${name}: ${match ? 'MATCH' : 'MISMATCH'} ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}

// Compute all discriminators
const idl = {
  "address": "6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz",
  "metadata": {
    "name": "fry_bridge_solana",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Fry Bridge Solana program"
  },
  "instructions": [
    {
      "name": "initialize",
      "discriminator": disc8("global:initialize"),
      "accounts": [
        { "name": "admin", "writable": true, "signer": true },
        { "name": "bridge_state", "writable": true, "signer": false },
        { "name": "sol_vault", "writable": true, "signer": false },
        { "name": "system_program", "address": "11111111111111111111111111111111" }
      ],
      "args": [
        { "name": "params", "type": { "defined": { "name": "InitializeParams" } } }
      ]
    },
    {
      "name": "set_relayer",
      "discriminator": disc8("global:set_relayer"),
      "accounts": [
        { "name": "admin", "signer": true },
        { "name": "bridge_state", "writable": true }
      ],
      "args": [
        { "name": "new_relayer", "type": "pubkey" }
      ]
    },
    {
      "name": "pause",
      "discriminator": disc8("global:pause"),
      "accounts": [
        { "name": "admin", "signer": true },
        { "name": "bridge_state", "writable": true }
      ],
      "args": []
    },
    {
      "name": "unpause",
      "discriminator": disc8("global:unpause"),
      "accounts": [
        { "name": "admin", "signer": true },
        { "name": "bridge_state", "writable": true }
      ],
      "args": []
    },
    {
      "name": "add_token_pair",
      "discriminator": disc8("global:add_token_pair"),
      "accounts": [
        { "name": "admin", "writable": true, "signer": true },
        { "name": "bridge_state" },
        { "name": "original_mint" },
        { "name": "wrapped_mint", "writable": true },
        { "name": "spl_vault", "writable": true },
        { "name": "token_program", "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { "name": "associated_token_program", "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
        { "name": "system_program", "address": "11111111111111111111111111111111" }
      ],
      "args": []
    },
    {
      "name": "lock_sol",
      "discriminator": disc8("global:lock_sol"),
      "accounts": [
        { "name": "user", "writable": true, "signer": true },
        { "name": "bridge_state", "writable": true },
        { "name": "sol_vault", "writable": true, "pda": { "seeds": [{"kind":"const","value":[115,111,108,95,118,97,117,108,116]}] } },
        { "name": "user_state", "writable": true, "pda": { "seeds": [{"kind":"const","value":[117,115,101,114,95,115,116,97,116,101]},{"kind":"account","path":"user"}] } },
        { "name": "lock_record", "writable": true, "pda": { "seeds": [{"kind":"const","value":[108,111,99,107,95,114,101,99,111,114,100]},{"kind":"account","path":"user"},{"kind":"arg","path":"nonce"}] } },
        { "name": "system_program", "address": "11111111111111111111111111111111" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" },
        { "name": "algorand_recipient", "type": "pubkey" }
      ]
    },
    {
      "name": "lock_spl",
      "discriminator": disc8("global:lock_spl"),
      "accounts": [
        { "name": "user", "writable": true, "signer": true },
        { "name": "bridge_state", "writable": true },
        { "name": "original_mint" },
        { "name": "user_token_account", "writable": true },
        { "name": "spl_vault", "writable": true },
        { "name": "user_state", "writable": true, "pda": { "seeds": [{"kind":"const","value":[117,115,101,114,95,115,116,97,116,101]},{"kind":"account","path":"user"}] } },
        { "name": "lock_record", "writable": true, "pda": { "seeds": [{"kind":"const","value":[108,111,99,107,95,114,101,99,111,114,100]},{"kind":"account","path":"user"},{"kind":"arg","path":"nonce"}] } },
        { "name": "token_program", "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { "name": "associated_token_program", "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
        { "name": "system_program", "address": "11111111111111111111111111111111" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" },
        { "name": "algorand_recipient", "type": "pubkey" }
      ]
    },
    {
      "name": "unlock_sol",
      "discriminator": disc8("global:unlock_sol"),
      "accounts": [
        { "name": "relayer", "signer": true },
        { "name": "bridge_state" },
        { "name": "sol_vault", "writable": true, "pda": { "seeds": [{"kind":"const","value":[115,111,108,95,118,97,117,108,116]}] } },
        { "name": "recipient", "writable": true },
        { "name": "lock_record_user" },
        { "name": "lock_record", "writable": true, "pda": { "seeds": [{"kind":"const","value":[108,111,99,107,95,114,101,99,111,114,100]},{"kind":"account","path":"lock_record_user"},{"kind":"arg","path":"nonce"}] } },
        { "name": "system_program", "address": "11111111111111111111111111111111" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" }
      ]
    },
    {
      "name": "unlock_spl",
      "discriminator": disc8("global:unlock_spl"),
      "accounts": [
        { "name": "relayer", "signer": true },
        { "name": "bridge_state", "writable": true, "pda": { "seeds": [{"kind":"const","value":[98,114,105,100,103,101,95,115,116,97,116,101]}] } },
        { "name": "original_mint" },
        { "name": "spl_vault", "writable": true },
        { "name": "recipient_token_account", "writable": true },
        { "name": "lock_record_user" },
        { "name": "lock_record", "writable": true, "pda": { "seeds": [{"kind":"const","value":[108,111,99,107,95,114,101,99,111,114,100]},{"kind":"account","path":"lock_record_user"},{"kind":"arg","path":"nonce"}] } },
        { "name": "token_program", "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" }
      ]
    },
    {
      "name": "mint_wrapped",
      "discriminator": disc8("global:mint_wrapped"),
      "accounts": [
        { "name": "relayer", "signer": true },
        { "name": "bridge_state", "writable": true, "pda": { "seeds": [{"kind":"const","value":[98,114,105,100,103,101,95,115,116,97,116,101]}] } },
        { "name": "original_mint" },
        { "name": "wrapped_mint", "writable": true, "pda": { "seeds": [{"kind":"const","value":[119,114,97,112,112,101,100,95,109,105,110,116]},{"kind":"account","path":"original_mint"}] } },
        { "name": "recipient_token_account", "writable": true },
        { "name": "token_program", "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" }
      ]
    },
    {
      "name": "burn_wrapped",
      "discriminator": disc8("global:burn_wrapped"),
      "accounts": [
        { "name": "user", "signer": true },
        { "name": "bridge_state" },
        { "name": "wrapped_mint", "writable": true },
        { "name": "user_wrapped_token_account", "writable": true },
        { "name": "token_program", "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }
      ],
      "args": [
        { "name": "nonce", "type": "u64" },
        { "name": "amount", "type": "u64" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "BridgeState",
      "discriminator": disc8("account:BridgeState"),
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "admin", "type": "pubkey" },
          { "name": "relayer", "type": "pubkey" },
          { "name": "paused", "type": "bool" },
          { "name": "per_tx_limit", "type": "u64" },
          { "name": "hourly_limit", "type": "u64" },
          { "name": "daily_limit", "type": "u64" },
          { "name": "time_lock_threshold", "type": "u64" },
          { "name": "time_lock_duration", "type": "i64" },
          { "name": "hourly_volume", "type": "u64" },
          { "name": "hourly_period_start", "type": "i64" },
          { "name": "daily_volume", "type": "u64" },
          { "name": "daily_period_start", "type": "i64" }
        ]
      }
    },
    {
      "name": "SolVault",
      "discriminator": disc8("account:SolVault"),
      "type": {
        "kind": "struct",
        "fields": []
      }
    },
    {
      "name": "UserState",
      "discriminator": disc8("account:UserState"),
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "next_nonce", "type": "u64" }
        ]
      }
    },
    {
      "name": "LockRecord",
      "discriminator": disc8("account:LockRecord"),
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "user", "type": "pubkey" },
          { "name": "algorand_recipient", "type": "pubkey" },
          { "name": "amount", "type": "u64" },
          { "name": "token_mint", "type": "pubkey" },
          { "name": "nonce", "type": "u64" },
          { "name": "timestamp", "type": "i64" },
          { "name": "time_locked_until", "type": "i64" },
          { "name": "consumed", "type": "bool" }
        ]
      }
    }
  ],
  "types": [
    {
      "name": "InitializeParams",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "relayer", "type": "pubkey" },
          { "name": "per_tx_limit", "type": "u64" },
          { "name": "hourly_limit", "type": "u64" },
          { "name": "daily_limit", "type": "u64" },
          { "name": "time_lock_threshold", "type": "u64" },
          { "name": "time_lock_duration", "type": "i64" }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "LockEvent",
      "discriminator": disc8("event:LockEvent"),
      "fields": [
        { "name": "user", "type": "pubkey", "index": false },
        { "name": "algorand_recipient", "type": "pubkey", "index": false },
        { "name": "amount", "type": "u64", "index": false },
        { "name": "token_mint", "type": "pubkey", "index": false },
        { "name": "nonce", "type": "u64", "index": false },
        { "name": "timestamp", "type": "i64", "index": false }
      ]
    },
    {
      "name": "UnlockEvent",
      "discriminator": disc8("event:UnlockEvent"),
      "fields": [
        { "name": "recipient", "type": "pubkey", "index": false },
        { "name": "amount", "type": "u64", "index": false },
        { "name": "token_mint", "type": "pubkey", "index": false },
        { "name": "nonce", "type": "u64", "index": false }
      ]
    },
    {
      "name": "MintEvent",
      "discriminator": disc8("event:MintEvent"),
      "fields": [
        { "name": "nonce", "type": "u64", "index": false },
        { "name": "recipient", "type": "pubkey", "index": false },
        { "name": "amount", "type": "u64", "index": false },
        { "name": "wrapped_mint", "type": "pubkey", "index": false }
      ]
    },
    {
      "name": "BurnEvent",
      "discriminator": disc8("event:BurnEvent"),
      "fields": [
        { "name": "nonce", "type": "u64", "index": false },
        { "name": "user", "type": "pubkey", "index": false },
        { "name": "amount", "type": "u64", "index": false },
        { "name": "wrapped_mint", "type": "pubkey", "index": false }
      ]
    }
  ],
  "errors": [
    { "code": 6000, "name": "InsufficientFunds", "msg": "Insufficient funds" },
    { "code": 6001, "name": "Paused", "msg": "Contract is paused" },
    { "code": 6002, "name": "Unauthorized", "msg": "Unauthorized" },
    { "code": 6003, "name": "RateLimitExceeded", "msg": "Rate limit exceeded" },
    { "code": 6004, "name": "TimeLocked", "msg": "Time locked" },
    { "code": 6005, "name": "InvalidNonce", "msg": "Invalid nonce" },
    { "code": 6006, "name": "InvalidTokenPair", "msg": "Invalid token pair" }
  ]
};

require('fs').writeFileSync('anchor/target/idl/fry_bridge_solana.json', JSON.stringify(idl, null, 2));
console.log('IDL written to anchor/target/idl/fry_bridge_solana.json');
