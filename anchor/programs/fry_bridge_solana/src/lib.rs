use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint as SplMint, MintTo, Token, TokenAccount, TransferChecked};

declare_id!("6SywTFsyXStoLJUSrsSzuupzK5SYEsTj5Jg9p9qr3vXz");

#[program]
pub mod fry_bridge_solana {
    use super::*;

    // ------------------------------------------------------------------
    // 1. Initialize
    // ------------------------------------------------------------------
    pub fn initialize(
        ctx: Context<Initialize>,
        params: InitializeParams,
    ) -> Result<()> {
        let state = &mut ctx.accounts.bridge_state;
        state.admin = ctx.accounts.admin.key();
        state.relayer = params.relayer;
        state.paused = false;
        state.per_tx_limit = params.per_tx_limit;
        state.hourly_limit = params.hourly_limit;
        state.daily_limit = params.daily_limit;
        state.time_lock_threshold = params.time_lock_threshold;
        state.time_lock_duration = params.time_lock_duration;

        let now = Clock::get()?.unix_timestamp;
        state.hourly_period_start = now;
        state.hourly_volume = 0;
        state.daily_period_start = now;
        state.daily_volume = 0;

        emit!(LockEvent {
            user: ctx.accounts.admin.key(),
            algorand_recipient: Pubkey::default(),
            amount: 0,
            token_mint: Pubkey::default(),
            nonce: 0,
            timestamp: now,
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 2. Set Relayer
    // ------------------------------------------------------------------
    pub fn set_relayer(
        ctx: Context<SetRelayer>,
        new_relayer: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.bridge_state.admin,
            BridgeError::Unauthorized
        );
        ctx.accounts.bridge_state.relayer = new_relayer;
        Ok(())
    }

    // ------------------------------------------------------------------
    // 3. Pause / Unpause
    // ------------------------------------------------------------------
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.bridge_state.admin,
            BridgeError::Unauthorized
        );
        ctx.accounts.bridge_state.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.bridge_state.admin,
            BridgeError::Unauthorized
        );
        ctx.accounts.bridge_state.paused = false;
        Ok(())
    }

    // ------------------------------------------------------------------
    // 4. Add Token Pair
    // ------------------------------------------------------------------
    pub fn add_token_pair(ctx: Context<AddTokenPair>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.bridge_state.admin,
            BridgeError::Unauthorized
        );
        Ok(())
    }

    // ------------------------------------------------------------------
    // 5. Lock SOL
    // ------------------------------------------------------------------
    pub fn lock_sol(
        ctx: Context<LockSol>,
        nonce: u64,
        amount: u64,
        algorand_recipient: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);
        require!(amount > 0, BridgeError::InsufficientFunds);

        let user_balance = ctx.accounts.user.lamports();
        require!(user_balance >= amount, BridgeError::InsufficientFunds);

        // Rate limits
        check_rate_limits(&mut ctx.accounts.bridge_state, amount)?;

        // Nonce
        let user_state = &mut ctx.accounts.user_state;
        require!(nonce == user_state.next_nonce, BridgeError::InvalidNonce);
        user_state.next_nonce += 1;

        // Time lock
        let now = Clock::get()?.unix_timestamp;
        let time_locked_until = if amount >= ctx.accounts.bridge_state.time_lock_threshold {
            now + ctx.accounts.bridge_state.time_lock_duration
        } else {
            0
        };

        // Record
        let record = &mut ctx.accounts.lock_record;
        record.user = ctx.accounts.user.key();
        record.algorand_recipient = algorand_recipient;
        record.amount = amount;
        record.token_mint = Pubkey::default(); // native SOL
        record.nonce = nonce;
        record.timestamp = now;
        record.time_locked_until = time_locked_until;
        record.consumed = false;

        // Transfer SOL
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        emit!(LockEvent {
            user: ctx.accounts.user.key(),
            algorand_recipient,
            amount,
            token_mint: Pubkey::default(),
            nonce,
            timestamp: now,
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 6. Lock SPL
    // ------------------------------------------------------------------
    pub fn lock_spl(
        ctx: Context<LockSpl>,
        nonce: u64,
        amount: u64,
        algorand_recipient: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);
        require!(amount > 0, BridgeError::InsufficientFunds);
        require!(
            ctx.accounts.user_token_account.amount >= amount,
            BridgeError::InsufficientFunds
        );

        check_rate_limits(&mut ctx.accounts.bridge_state, amount)?;

        let user_state = &mut ctx.accounts.user_state;
        require!(nonce == user_state.next_nonce, BridgeError::InvalidNonce);
        user_state.next_nonce += 1;

        let now = Clock::get()?.unix_timestamp;
        let time_locked_until = if amount >= ctx.accounts.bridge_state.time_lock_threshold {
            now + ctx.accounts.bridge_state.time_lock_duration
        } else {
            0
        };

        let record = &mut ctx.accounts.lock_record;
        record.user = ctx.accounts.user.key();
        record.algorand_recipient = algorand_recipient;
        record.amount = amount;
        record.token_mint = ctx.accounts.original_mint.key();
        record.nonce = nonce;
        record.timestamp = now;
        record.time_locked_until = time_locked_until;
        record.consumed = false;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.spl_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.original_mint.to_account_info(),
            },
        );
        token::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.original_mint.decimals,
        )?;

        emit!(LockEvent {
            user: ctx.accounts.user.key(),
            algorand_recipient,
            amount,
            token_mint: ctx.accounts.original_mint.key(),
            nonce,
            timestamp: now,
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 7. Unlock SOL
    // ------------------------------------------------------------------
    pub fn unlock_sol(
        ctx: Context<UnlockSol>,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.relayer.key() == ctx.accounts.bridge_state.relayer,
            BridgeError::Unauthorized
        );
        require!(!ctx.accounts.lock_record.consumed, BridgeError::InvalidNonce);
        require!(
            ctx.accounts.lock_record.user == ctx.accounts.recipient.key(),
            BridgeError::Unauthorized
        );

        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.lock_record.time_locked_until, BridgeError::TimeLocked);
        require!(
            ctx.accounts.sol_vault.to_account_info().lamports() >= amount,
            BridgeError::InsufficientFunds
        );

        // Direct lamport manipulation (sol_vault carries account data, CPI transfer fails)
        let vault_info = ctx.accounts.sol_vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amount)
            .ok_or(BridgeError::InsufficientFunds)?;
        **recipient_info.try_borrow_mut_lamports()? = recipient_info
            .lamports()
            .checked_add(amount)
            .ok_or(BridgeError::Overflow)?;

        ctx.accounts.lock_record.consumed = true;

        emit!(UnlockEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            token_mint: Pubkey::default(),
            nonce,
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 8. Unlock SPL
    // ------------------------------------------------------------------
    pub fn unlock_spl(
        ctx: Context<UnlockSpl>,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.relayer.key() == ctx.accounts.bridge_state.relayer,
            BridgeError::Unauthorized
        );
        require!(!ctx.accounts.lock_record.consumed, BridgeError::InvalidNonce);
        require!(
            ctx.accounts.lock_record.user == ctx.accounts.recipient_token_account.owner,
            BridgeError::Unauthorized
        );

        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.lock_record.time_locked_until, BridgeError::TimeLocked);
        require!(
            ctx.accounts.spl_vault.amount >= amount,
            BridgeError::InsufficientFunds
        );

        let bridge_seeds = &[b"bridge_state".as_ref(), &[ctx.bumps.bridge_state]];
        let signer = &[&bridge_seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.spl_vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.bridge_state.to_account_info(),
                mint: ctx.accounts.original_mint.to_account_info(),
            },
            signer,
        );
        token::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.original_mint.decimals,
        )?;

        ctx.accounts.lock_record.consumed = true;

        emit!(UnlockEvent {
            recipient: ctx.accounts.recipient_token_account.owner,
            amount,
            token_mint: ctx.accounts.original_mint.key(),
            nonce,
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 9. Mint Wrapped
    // ------------------------------------------------------------------
    pub fn mint_wrapped(
        ctx: Context<MintWrapped>,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.relayer.key() == ctx.accounts.bridge_state.relayer,
            BridgeError::Unauthorized
        );
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);

        let bridge_seeds = &[b"bridge_state".as_ref(), &[ctx.bumps.bridge_state]];
        let signer = &[&bridge_seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.bridge_state.to_account_info(),
            },
            signer,
        );
        token::mint_to(cpi_ctx, amount)?;

        emit!(MintEvent {
            nonce,
            recipient: ctx.accounts.recipient_token_account.owner,
            amount,
            wrapped_mint: ctx.accounts.wrapped_mint.key(),
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 10. Burn Wrapped
    // ------------------------------------------------------------------
    pub fn burn_wrapped(
        ctx: Context<BurnWrapped>,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);
        require!(
            ctx.accounts.user_wrapped_token_account.amount >= amount,
            BridgeError::InsufficientFunds
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                from: ctx.accounts.user_wrapped_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::burn(cpi_ctx, amount)?;

        emit!(BurnEvent {
            nonce,
            user: ctx.accounts.user.key(),
            amount,
            wrapped_mint: ctx.accounts.wrapped_mint.key(),
        });

        Ok(())
    }

    // ------------------------------------------------------------------
    // 11. Release SOL (cross-chain: Algorand burn → Solana release)
    // ------------------------------------------------------------------
    pub fn release_sol(
        ctx: Context<ReleaseSol>,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.relayer.key() == ctx.accounts.bridge_state.relayer,
            BridgeError::Unauthorized
        );
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);

        check_rate_limits(&mut ctx.accounts.bridge_state, amount)?;

        require!(
            ctx.accounts.sol_vault.to_account_info().lamports() >= amount,
            BridgeError::InsufficientFunds
        );

        // Direct lamport manipulation (sol_vault carries account data, CPI transfer fails)
        let vault_info = ctx.accounts.sol_vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amount)
            .ok_or(BridgeError::InsufficientFunds)?;
        **recipient_info.try_borrow_mut_lamports()? = recipient_info
            .lamports()
            .checked_add(amount)
            .ok_or(BridgeError::Overflow)?;

        emit!(ReleaseEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            nonce,
        });

        Ok(())
    }
}

// ===================================================================
// Rate-limit helper
// ===================================================================
fn check_rate_limits(bridge_state: &mut BridgeState, amount: u64) -> Result<()> {
    require!(amount <= bridge_state.per_tx_limit, BridgeError::RateLimitExceeded);

    let now = Clock::get()?.unix_timestamp;

    // Hourly bucket
    if now - bridge_state.hourly_period_start >= 3600 {
        bridge_state.hourly_period_start = now;
        bridge_state.hourly_volume = 0;
    }
    bridge_state.hourly_volume += amount;
    require!(
        bridge_state.hourly_volume <= bridge_state.hourly_limit,
        BridgeError::RateLimitExceeded
    );

    // Daily bucket
    if now - bridge_state.daily_period_start >= 86400 {
        bridge_state.daily_period_start = now;
        bridge_state.daily_volume = 0;
    }
    bridge_state.daily_volume += amount;
    require!(
        bridge_state.daily_volume <= bridge_state.daily_limit,
        BridgeError::RateLimitExceeded
    );

    Ok(())
}

// ===================================================================
// Accounts
// ===================================================================
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"bridge_state"],
        bump,
        space = 8 + 32 + 32 + 1 + 8*5 + 8*4 + 64 // generous padding
    )]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"sol_vault"],
        bump,
        space = 8
    )]
    pub sol_vault: Account<'info, SolVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRelayer<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
}

#[derive(Accounts)]
pub struct AddTokenPair<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub bridge_state: Account<'info, BridgeState>,

    pub original_mint: Account<'info, SplMint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"wrapped_mint", original_mint.key().as_ref()],
        bump,
        mint::decimals = original_mint.decimals,
        mint::authority = bridge_state,
    )]
    pub wrapped_mint: Account<'info, SplMint>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = original_mint,
        associated_token::authority = bridge_state,
    )]
    pub spl_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct LockSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(mut, seeds = [b"sol_vault"], bump)]
    pub sol_vault: Account<'info, SolVault>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"user_state", user.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_state: Account<'info, UserState>,

    #[account(
        init,
        payer = user,
        seeds = [b"lock_record", user.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
        space = 8 + 32 + 8 + 32 + 8 + 8 + 8 + 1 + 32 // generous
    )]
    pub lock_record: Account<'info, LockRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct LockSpl<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,

    pub original_mint: Account<'info, SplMint>,

    #[account(
        mut,
        token::mint = original_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = original_mint,
        associated_token::authority = bridge_state,
    )]
    pub spl_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"user_state", user.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_state: Account<'info, UserState>,

    #[account(
        init,
        payer = user,
        seeds = [b"lock_record", user.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
        space = 8 + 32 + 8 + 32 + 8 + 8 + 8 + 1 + 32
    )]
    pub lock_record: Account<'info, LockRecord>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct UnlockSol<'info> {
    pub relayer: Signer<'info>,
    pub bridge_state: Account<'info, BridgeState>,

    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump,
    )]
    pub sol_vault: Account<'info, SolVault>,

    /// CHECK: recipient may be any system account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// CHECK: needed for seeds only
    pub lock_record_user: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"lock_record", lock_record_user.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub lock_record: Account<'info, LockRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct UnlockSpl<'info> {
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump,
    )]
    pub bridge_state: Account<'info, BridgeState>,

    pub original_mint: Account<'info, SplMint>,

    #[account(
        mut,
        associated_token::mint = original_mint,
        associated_token::authority = bridge_state,
    )]
    pub spl_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = original_mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: needed for seeds only
    pub lock_record_user: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"lock_record", lock_record_user.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub lock_record: Account<'info, LockRecord>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MintWrapped<'info> {
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump,
    )]
    pub bridge_state: Account<'info, BridgeState>,

    pub original_mint: Account<'info, SplMint>,

    #[account(
        mut,
        seeds = [b"wrapped_mint", original_mint.key().as_ref()],
        bump,
    )]
    pub wrapped_mint: Account<'info, SplMint>,

    #[account(
        mut,
        token::mint = wrapped_mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnWrapped<'info> {
    pub user: Signer<'info>,
    pub bridge_state: Account<'info, BridgeState>,

    #[account(mut)]
    pub wrapped_mint: Account<'info, SplMint>,

    #[account(
        mut,
        token::mint = wrapped_mint,
        token::authority = user,
    )]
    pub user_wrapped_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ReleaseSol<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump,
    )]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump,
    )]
    pub sol_vault: Account<'info, SolVault>,

    /// CHECK: recipient receives SOL
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = relayer,
        seeds = [b"release_record", recipient.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        space = 8,
    )]
    pub release_record: Account<'info, ReleaseRecord>,

    pub system_program: Program<'info, System>,
}

// ===================================================================
// Data structures
// ===================================================================
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct InitializeParams {
    pub relayer: Pubkey,
    pub per_tx_limit: u64,
    pub hourly_limit: u64,
    pub daily_limit: u64,
    pub time_lock_threshold: u64,
    pub time_lock_duration: i64,
}

#[account]
pub struct BridgeState {
    pub admin: Pubkey,
    pub relayer: Pubkey,
    pub paused: bool,
    pub per_tx_limit: u64,
    pub hourly_limit: u64,
    pub daily_limit: u64,
    pub time_lock_threshold: u64,
    pub time_lock_duration: i64,
    pub hourly_volume: u64,
    pub hourly_period_start: i64,
    pub daily_volume: u64,
    pub daily_period_start: i64,
}

#[account]
pub struct SolVault {}

#[account]
pub struct UserState {
    pub next_nonce: u64,
}

#[account]
pub struct LockRecord {
    pub user: Pubkey,
    pub algorand_recipient: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub nonce: u64,
    pub timestamp: i64,
    pub time_locked_until: i64,
    pub consumed: bool,
}

#[account]
pub struct ReleaseRecord {}

// ===================================================================
// Events
// ===================================================================
#[event]
pub struct LockEvent {
    pub user: Pubkey,
    pub algorand_recipient: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnlockEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub nonce: u64,
}

#[event]
pub struct MintEvent {
    pub nonce: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    pub wrapped_mint: Pubkey,
}

#[event]
pub struct BurnEvent {
    pub nonce: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub wrapped_mint: Pubkey,
}

#[event]
pub struct ReleaseEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

// ===================================================================
// Errors
// ===================================================================
#[error_code]
pub enum BridgeError {
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Contract is paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Rate limit exceeded")]
    RateLimitExceeded,
    #[msg("Time locked")]
    TimeLocked,
    #[msg("Invalid nonce")]
    InvalidNonce,
    #[msg("Invalid token pair")]
    InvalidTokenPair,
    #[msg("Arithmetic overflow")]
    Overflow,
}
