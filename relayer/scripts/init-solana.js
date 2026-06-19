const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const fs = require('fs');

const PROGRAM_ID = new web3.PublicKey('6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz');
const TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;
const ASSOCIATED_TOKEN_PROGRAM_ID = splToken.ASSOCIATED_TOKEN_PROGRAM_ID;
const KEYPAIR_PATH = 'REDACTED_ROTATE_ME/.config/solana/id.json';

// Discriminators
const INITIALIZE_DISC = Buffer.from([175,175,109,31,13,152,155,237]);
const ADD_TOKEN_PAIR_DISC = Buffer.from([155,3,0,67,226,193,214,123]);

function serializeU64LE(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(n), 0);
    return buf;
}
function serializeI64LE(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(n), 0);
    return buf;
}

async function main() {
    const connection = new web3.Connection('http://localhost:8899', 'confirmed');
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8')));
    const payer = web3.Keypair.fromSecretKey(secretKey);

    console.log('Admin:', payer.publicKey.toBase58());

    // Airdrop if needed
    const bal = await connection.getBalance(payer.publicKey);
    if (bal < 2_000_000_000) {
        console.log('Airdropping 10 SOL...');
        await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
        await new Promise(r => setTimeout(r, 3000));
    }

    // Derive PDAs
    const [bridgeState] = web3.PublicKey.findProgramAddressSync([Buffer.from('bridge_state')], PROGRAM_ID);
    const [solVault] = web3.PublicKey.findProgramAddressSync([Buffer.from('sol_vault')], PROGRAM_ID);
    console.log('BridgeState:', bridgeState.toBase58());
    console.log('SolVault:', solVault.toBase58());

    // Build Initialize instruction
    // Args: relayer(32), per_tx_limit(8), hourly_limit(8), daily_limit(8), time_lock_threshold(8), time_lock_duration(8)
    const initData = Buffer.concat([
        INITIALIZE_DISC,
        payer.publicKey.toBuffer(),
        serializeU64LE(1_000_000),
        serializeU64LE(10_000_000),
        serializeU64LE(100_000_000),
        serializeU64LE(10_000_000),
        serializeI64LE(300),
    ]);

    const initIx = new web3.TransactionInstruction({
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: bridgeState, isSigner: false, isWritable: true },
            { pubkey: solVault, isSigner: false, isWritable: true },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: initData,
    });

    const tx1 = new web3.Transaction().add(initIx);
    tx1.feePayer = payer.publicKey;
    tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx1.sign(payer);
    const sig1 = await connection.sendRawTransaction(tx1.serialize());
    await connection.confirmTransaction(sig1, 'confirmed');
    console.log('Initialized:', sig1);

    // Create dummy SPL mint
    const mint = await splToken.createMint(connection, payer, payer.publicKey, null, 6);
    console.log('DummyMint:', mint.toBase58());

    // Derive wrapped_mint PDA and spl_vault ATA
    const [wrappedMint] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('wrapped_mint'), mint.toBuffer()],
        PROGRAM_ID
    );
    const splVault = await splToken.getAssociatedTokenAddress(mint, bridgeState, true);
    console.log('WrappedMint:', wrappedMint.toBase58());
    console.log('SplVault:', splVault.toBase58());

    // Build AddTokenPair instruction
    const addData = Buffer.concat([ADD_TOKEN_PAIR_DISC]);

    const addIx = new web3.TransactionInstruction({
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: bridgeState, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: wrappedMint, isSigner: false, isWritable: true },
            { pubkey: splVault, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: addData,
    });

    const tx2 = new web3.Transaction().add(addIx);
    tx2.feePayer = payer.publicKey;
    tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx2.sign(payer);
    const sig2 = await connection.sendRawTransaction(tx2.serialize());
    await connection.confirmTransaction(sig2, 'confirmed');
    console.log('TokenPairAdded:', sig2);
}

main().catch(e => { console.error(e); process.exit(1); });
