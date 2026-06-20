import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    getAccount,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fry_bridge_solana", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = (anchor.workspace as any).FryBridgeSolana as Program<any>;

    const admin = provider.wallet as any;
    const relayer = Keypair.generate();
    const user = Keypair.generate();
    const fakeRelayer = Keypair.generate();

    let bridgeState: PublicKey;
    let bridgeBump: number;
    let solVault: PublicKey;
    let solVaultBump: number;

    let originalMint: PublicKey;
    let userOriginalATA: PublicKey;
    let splVault: PublicKey;
    let wrappedMint: PublicKey;
    let userWrappedATA: PublicKey;
    let mintAuthority: Keypair;

    before(async () => {
        // Airdrops
        const sig1 = await provider.connection.requestAirdrop(relayer.publicKey, 10 * LAMPORTS_PER_SOL);
        const sig2 = await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        const sig3 = await provider.connection.requestAirdrop(fakeRelayer.publicKey, 1 * LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig1, "confirmed");
        await provider.connection.confirmTransaction(sig2, "confirmed");
        await provider.connection.confirmTransaction(sig3, "confirmed");

        // PDAs
        [bridgeState, bridgeBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge_state")],
            program.programId
        );
        [solVault, solVaultBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("sol_vault")],
            program.programId
        );

        // Original token setup
        mintAuthority = Keypair.generate();
        originalMint = await createMint(
            provider.connection,
            admin.payer,
            mintAuthority.publicKey,
            null,
            6
        );

        const userOrigAcc = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin.payer,
            originalMint,
            user.publicKey
        );
        userOriginalATA = userOrigAcc.address;

        await mintTo(
            provider.connection,
            admin.payer,
            originalMint,
            userOriginalATA,
            mintAuthority,
            1_000_000_000
        );

        // Pre-compute wrapped mint and spl vault
        [wrappedMint] = PublicKey.findProgramAddressSync(
            [Buffer.from("wrapped_mint"), originalMint.toBuffer()],
            program.programId
        );
        splVault = getAssociatedTokenAddressSync(originalMint, bridgeState, true);
    });

    it("Initializes the bridge", async () => {
        await program.methods
            .initialize({
                relayer: relayer.publicKey,
                perTxLimit: new BN(1_000_000),
                hourlyLimit: new BN(3_000_000),
                dailyLimit: new BN(10_000_000),
                timeLockThreshold: new BN(500_000),
                timeLockDuration: new BN(10),
            })
            .accounts({
                admin: admin.publicKey,
                bridgeState,
                solVault,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const state = await program.account.bridgeState.fetch(bridgeState);
        assert.ok(state.relayer.equals(relayer.publicKey));
        assert.equal(state.paused, false);
    });

    it("Adds a token pair", async () => {
        await program.methods
            .addTokenPair()
            .accounts({
                admin: admin.publicKey,
                bridgeState,
                originalMint,
                wrappedMint,
                splVault,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const mintInfo = await provider.connection.getAccountInfo(wrappedMint);
        assert.ok(mintInfo !== null);
    });

    it("Creates user wrapped token account", async () => {
        const acc = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin.payer,
            wrappedMint,
            user.publicKey
        );
        userWrappedATA = acc.address;
        assert.ok(userWrappedATA);
    });

    // -----------------------------------------------------------
    // Rate limits
    // -----------------------------------------------------------
    it("Enforces per-transaction rate limit", async () => {
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );
        const nonce = 0;
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        try {
            await program.methods
                .lockSol(new BN(nonce), new BN(2_000_000), relayer.publicKey)
                .accounts({
                    user: user.publicKey,
                    bridgeState,
                    solVault,
                    userState,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();
            assert.fail("expected rate-limit failure");
        } catch (err: any) {
            assert.include(String(err), "RateLimitExceeded");
        }
    });

    it("Enforces hourly rate limit", async () => {
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );

        // Two successful locks (nonce 0, 1)
        for (let i = 0; i < 2; i++) {
            const nonce = i;
            const nonceBuf = Buffer.alloc(8);
            new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
            const [lockRecord] = PublicKey.findProgramAddressSync(
                [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
                program.programId
            );
            await program.methods
                .lockSol(new BN(nonce), new BN(100_000), relayer.publicKey)
                .accounts({
                    user: user.publicKey,
                    bridgeState,
                    solVault,
                    userState,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();
        }

        // Third lock (nonce=2) should breach hourly limit (300k > 200k)
        const nonce = 2;
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        try {
            await program.methods
                .lockSol(new BN(nonce), new BN(100_000), relayer.publicKey)
                .accounts({
                    user: user.publicKey,
                    bridgeState,
                    solVault,
                    userState,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();
            assert.fail("expected hourly rate-limit failure");
        } catch (err: any) {
            assert.include(String(err), "RateLimitExceeded");
        }
    });

    // -----------------------------------------------------------
    // Lock / Unlock SOL
    // -----------------------------------------------------------
    it("Locks SOL", async () => {
        const nonce = 2; // first free nonce after failed rate-limit
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        await program.methods
            .lockSol(new BN(nonce), new BN(50_000), relayer.publicKey)
            .accounts({
                user: user.publicKey,
                bridgeState,
                solVault,
                userState,
                lockRecord,
                systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        const record = await program.account.lockRecord.fetch(lockRecord);
        assert.ok(record.user.equals(user.publicKey));
        assert.equal(record.amount.toNumber(), 50_000);
        assert.equal(record.consumed, false);
    });

    it("Rejects unauthorized unlock", async () => {
        const nonce = 2;
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        try {
            await program.methods
                .unlockSol(new BN(nonce), new BN(50_000))
                .accounts({
                    relayer: fakeRelayer.publicKey,
                    bridgeState,
                    solVault,
                    recipient: user.publicKey,
                    lockRecordUser: user.publicKey,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([fakeRelayer])
                .rpc();
            assert.fail("expected unauthorized failure");
        } catch (err: any) {
            assert.include(String(err), "Unauthorized");
        }
    });

    it("Unlocks SOL", async () => {
        const nonce = 2;
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        const beforeBalance = await provider.connection.getBalance(user.publicKey);

        await program.methods
            .unlockSol(new BN(nonce), new BN(50_000))
            .accounts({
                relayer: relayer.publicKey,
                bridgeState,
                solVault,
                recipient: user.publicKey,
                lockRecordUser: user.publicKey,
                lockRecord,
                systemProgram: SystemProgram.programId,
            })
            .signers([relayer])
            .rpc();

        const afterBalance = await provider.connection.getBalance(user.publicKey);
        assert.ok(afterBalance > beforeBalance);

        const record = await program.account.lockRecord.fetch(lockRecord);
        assert.equal(record.consumed, true);
    });

    it("Prevents replay (double unlock)", async () => {
        const nonce = 2;
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        try {
            await program.methods
                .unlockSol(new BN(nonce), new BN(50_000))
                .accounts({
                    relayer: relayer.publicKey,
                    bridgeState,
                    solVault,
                    recipient: user.publicKey,
                    lockRecordUser: user.publicKey,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([relayer])
                .rpc();
            assert.fail("expected replay failure");
        } catch (err: any) {
            assert.include(String(err), "InvalidNonce");
        }
    });

    // -----------------------------------------------------------
    // Lock / Unlock SPL
    // -----------------------------------------------------------
    it("Locks SPL", async () => {
        const nonce = 3;
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        const beforeVault = await getAccount(provider.connection, splVault);
        await program.methods
            .lockSpl(new BN(nonce), new BN(50_000), relayer.publicKey)
            .accounts({
                user: user.publicKey,
                bridgeState,
                originalMint,
                userTokenAccount: userOriginalATA,
                splVault,
                userState,
                lockRecord,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();
        const afterVault = await getAccount(provider.connection, splVault);
        assert.equal(Number(afterVault.amount) - Number(beforeVault.amount), 50_000);
    });

    // -----------------------------------------------------------
    // Mint / Burn wrapped
    // -----------------------------------------------------------
    it("Mints wrapped tokens", async () => {
        const beforeAcc = await getAccount(provider.connection, userWrappedATA);
        await program.methods
            .mintWrapped(new BN(0), new BN(100_000))
            .accounts({
                relayer: relayer.publicKey,
                bridgeState,
                originalMint,
                wrappedMint,
                recipientTokenAccount: userWrappedATA,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([relayer])
            .rpc();
        const afterAcc = await getAccount(provider.connection, userWrappedATA);
        assert.equal(Number(afterAcc.amount) - Number(beforeAcc.amount), 100_000);
    });

    it("Burns wrapped tokens", async () => {
        const beforeAcc = await getAccount(provider.connection, userWrappedATA);
        await program.methods
            .burnWrapped(new BN(0), new BN(30_000))
            .accounts({
                user: user.publicKey,
                bridgeState,
                wrappedMint,
                userWrappedTokenAccount: userWrappedATA,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();
        const afterAcc = await getAccount(provider.connection, userWrappedATA);
        assert.equal(Number(beforeAcc.amount) - Number(afterAcc.amount), 30_000);
    });

    // -----------------------------------------------------------
    // Time lock
    // -----------------------------------------------------------
    it("Enforces time lock", async () => {
        const nonce = 4;
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        await program.methods
            .lockSol(new BN(nonce), new BN(600_000), relayer.publicKey)
            .accounts({
                user: user.publicKey,
                bridgeState,
                solVault,
                userState,
                lockRecord,
                systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        const record = await program.account.lockRecord.fetch(lockRecord);
        assert.ok(record.timeLockedUntil.gt(new BN(0)));

        // Immediate unlock should fail
        try {
            await program.methods
                .unlockSol(new BN(nonce), new BN(600_000))
                .accounts({
                    relayer: relayer.publicKey,
                    bridgeState,
                    solVault,
                    recipient: user.publicKey,
                    lockRecordUser: user.publicKey,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([relayer])
                .rpc();
            assert.fail("expected time-locked failure");
        } catch (err: any) {
            assert.include(String(err), "TimeLocked");
        }

        // Wait for time lock to expire
        await sleep(11_000);

        await program.methods
            .unlockSol(new BN(nonce), new BN(600_000))
            .accounts({
                relayer: relayer.publicKey,
                bridgeState,
                solVault,
                recipient: user.publicKey,
                lockRecordUser: user.publicKey,
                lockRecord,
                systemProgram: SystemProgram.programId,
            })
            .signers([relayer])
            .rpc();

        const recordAfter = await program.account.lockRecord.fetch(lockRecord);
        assert.equal(recordAfter.consumed, true);
    });

    // -----------------------------------------------------------
    // Pause
    // -----------------------------------------------------------
    it("Pauses and resumes the bridge", async () => {
        await program.methods
            .pause()
            .accounts({
                admin: admin.publicKey,
                bridgeState,
            })
            .rpc();

        const pausedState = await program.account.bridgeState.fetch(bridgeState);
        assert.equal(pausedState.paused, true);

        // Attempt lock while paused
        const nonce = 5;
        const [userState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            program.programId
        );
        const nonceBuf = Buffer.alloc(8);
        new BN(nonce).toArrayLike(Buffer, "le", 8).copy(nonceBuf);
        const [lockRecord] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_record"), user.publicKey.toBuffer(), nonceBuf],
            program.programId
        );

        try {
            await program.methods
                .lockSol(new BN(nonce), new BN(10_000), relayer.publicKey)
                .accounts({
                    user: user.publicKey,
                    bridgeState,
                    solVault,
                    userState,
                    lockRecord,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();
            assert.fail("expected paused failure");
        } catch (err: any) {
            assert.include(String(err), "Paused");
        }

        // Unpause
        await program.methods
            .unpause()
            .accounts({
                admin: admin.publicKey,
                bridgeState,
            })
            .rpc();

        const resumedState = await program.account.bridgeState.fetch(bridgeState);
        assert.equal(resumedState.paused, false);
    });
});
