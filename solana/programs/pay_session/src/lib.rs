//! Prepaid payment sessions for pay-per-call APIs.
//!
//! A buyer deposits tokens (USDC) into a vault owned by a session account, naming
//! a seller and a `signer` key. For each API call the buyer signs, off-chain, the
//! running total it owes: `cumulative`. The seller keeps only the latest receipt
//! and redeems it whenever it likes; one `redeem` pays out everything since the
//! last one. After `expires_at` the buyer can close the session and take back
//! whatever wasn't redeemed.
//!
//! Safety properties (each has a test in `tests/`):
//! - Receipts are bound to this program, this session, this session's lifetime
//!   (the slot it was opened in) and an amount, so they can't be replayed against
//!   another session or deployment, or against the same address re-opened later.
//! - `cumulative` only moves forward and can't exceed the deposit, so a receipt
//!   can be redeemed at most once and the seller can never take more than was
//!   deposited.
//! - The ed25519 signature is checked by Solana's ed25519 precompile in the
//!   instruction right before `redeem`; this program confirms that instruction
//!   covers exactly one signature, by the session's signer, over the expected
//!   message, with all data inside that instruction (no offsets pointing into
//!   other instructions, the classic spoofing trick).
//! - Before expiry only the seller can close (refunding the buyer). The buyer
//!   can't pull funds back while the seller may still hold unredeemed receipts.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ed25519_program, sysvar::instructions as ix_sysvar};
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("E5fA3t5xQkhjSiwrE5EzJ4wgr9fWSbTZzXsVxgKjGy3T");

/// Domain separator at the start of every receipt (16 bytes).
pub const RECEIPT_DOMAIN: &[u8; 16] = b"x402-session-v2\0";
/// Receipt = domain || program id || session || opened_slot (u64 LE) || cumulative (u64 LE).
pub const RECEIPT_LEN: usize = 16 + 32 + 32 + 8 + 8;
/// Sessions must last at least this long, so the seller has time to redeem.
pub const MIN_DURATION_SECS: i64 = 15 * 60;
/// And at most this long, so deposits can't be locked away indefinitely.
pub const MAX_DURATION_SECS: i64 = 30 * 24 * 60 * 60;

/// `opened_slot` identifies one lifetime of a session address. A session PDA can be closed and
/// re-opened with the same seeds; without it, receipts from the earlier lifetime would be valid
/// again against the new deposit.
pub fn receipt_message(program: &Pubkey, session: &Pubkey, opened_slot: u64, cumulative: u64) -> [u8; RECEIPT_LEN] {
    let mut m = [0u8; RECEIPT_LEN];
    m[..16].copy_from_slice(RECEIPT_DOMAIN);
    m[16..48].copy_from_slice(program.as_ref());
    m[48..80].copy_from_slice(session.as_ref());
    m[80..88].copy_from_slice(&opened_slot.to_le_bytes());
    m[88..].copy_from_slice(&cumulative.to_le_bytes());
    m
}

#[program]
pub mod pay_session {
    use super::*;

    pub fn open_session(ctx: Context<OpenSession>, nonce: u64, deposit: u64, expires_at: i64, signer: Pubkey) -> Result<()> {
        require!(deposit > 0, SessionError::ZeroAmount);
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(expires_at >= now + MIN_DURATION_SECS, SessionError::DurationTooShort);
        require!(expires_at <= now + MAX_DURATION_SECS, SessionError::DurationTooLong);
        require_keys_neq!(ctx.accounts.buyer.key(), ctx.accounts.seller.key(), SessionError::BuyerIsSeller);

        let s = &mut ctx.accounts.session;
        s.buyer = ctx.accounts.buyer.key();
        s.seller = ctx.accounts.seller.key();
        s.mint = ctx.accounts.mint.key();
        s.signer = signer;
        s.nonce = nonce;
        s.deposit = deposit;
        s.redeemed = 0;
        s.expires_at = expires_at;
        s.bump = ctx.bumps.session;
        s.vault_bump = ctx.bumps.vault;
        s.opened_slot = clock.slot;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            deposit,
            ctx.accounts.mint.decimals,
        )?;
        emit!(SessionOpened { session: s.key(), buyer: s.buyer, seller: s.seller, deposit, expires_at });
        Ok(())
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        require!(amount > 0, SessionError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.session.expires_at, SessionError::Expired);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        let s = &mut ctx.accounts.session;
        s.deposit = s.deposit.checked_add(amount).ok_or(SessionError::Overflow)?;
        emit!(SessionToppedUp { session: s.key(), amount, deposit: s.deposit });
        Ok(())
    }

    /// Pay the seller everything owed up to `cumulative`, proven by the buyer's signed receipt.
    pub fn redeem(ctx: Context<Redeem>, cumulative: u64) -> Result<()> {
        let session_key = ctx.accounts.session.key();
        let s = &ctx.accounts.session;
        require!(cumulative > s.redeemed, SessionError::NotIncreasing);
        require!(cumulative <= s.deposit, SessionError::ExceedsDeposit);
        let expected = receipt_message(&crate::ID, &session_key, s.opened_slot, cumulative);
        verify_preceding_ed25519(&ctx.accounts.instructions, &s.signer, &expected)?;

        let amount = cumulative - s.redeemed;
        let nonce = s.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"session", s.buyer.as_ref(), s.seller.as_ref(), &nonce, &[s.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.seller_token.to_account_info(),
                    authority: ctx.accounts.session.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.session.redeemed = cumulative;
        emit!(SessionRedeemed { session: session_key, amount, cumulative });
        Ok(())
    }

    /// Refund the unredeemed balance to the buyer and close. The buyer may close only after expiry;
    /// the seller may close at any time (it forfeits any receipts it hasn't redeemed).
    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        let s = &ctx.accounts.session;
        let caller = ctx.accounts.caller.key();
        if caller == s.buyer {
            require!(Clock::get()?.unix_timestamp >= s.expires_at, SessionError::NotExpired);
        } else {
            require_keys_eq!(caller, s.seller, SessionError::Unauthorized);
        }
        let refund = ctx.accounts.vault.amount;
        let redeemed = s.redeemed;
        let nonce = s.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"session", s.buyer.as_ref(), s.seller.as_ref(), &nonce, &[s.bump]];
        if refund > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.session.to_account_info(),
                    },
                    &[seeds],
                ),
                refund,
                ctx.accounts.mint.decimals,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.session.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(SessionClosed { session: ctx.accounts.session.key(), refund, redeemed, by: caller });
        Ok(())
    }
}

/// Ed25519 precompile instruction layout: 1-byte count, 1-byte padding, then for each
/// signature seven little-endian u16s: sig offset, sig ix index, pubkey offset, pubkey ix
/// index, message offset, message size, message ix index.
const ED25519_HEADER: usize = 2;
const ED25519_OFFSETS: usize = 14;
/// "This instruction" in the precompile's offset scheme.
const SAME_IX: u16 = u16::MAX;

fn read_u16(d: &[u8], at: usize) -> Result<u16> {
    let b = d.get(at..at + 2).ok_or(SessionError::BadSignatureInstruction)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

pub fn verify_preceding_ed25519(instructions: &AccountInfo, signer: &Pubkey, expected: &[u8]) -> Result<()> {
    let current = ix_sysvar::load_current_index_checked(instructions)? as usize;
    require!(current > 0, SessionError::MissingSignatureInstruction);
    let ix = ix_sysvar::load_instruction_at_checked(current - 1, instructions)?;
    require_keys_eq!(ix.program_id, ed25519_program::ID, SessionError::MissingSignatureInstruction);
    let d = &ix.data;
    require!(d.len() >= ED25519_HEADER + ED25519_OFFSETS && d[0] == 1, SessionError::BadSignatureInstruction);
    let o = ED25519_HEADER;
    let (sig_ix, pk_off, pk_ix) = (read_u16(d, o + 2)?, read_u16(d, o + 4)? as usize, read_u16(d, o + 6)?);
    let (msg_off, msg_len, msg_ix) = (read_u16(d, o + 8)? as usize, read_u16(d, o + 10)? as usize, read_u16(d, o + 12)?);
    // Everything the precompile verified must live in that same instruction, or the
    // bytes read below might not be the bytes it checked.
    require!(sig_ix == SAME_IX && pk_ix == SAME_IX && msg_ix == SAME_IX, SessionError::BadSignatureInstruction);
    let pk = d.get(pk_off..pk_off + 32).ok_or(SessionError::BadSignatureInstruction)?;
    require!(pk == signer.as_ref(), SessionError::WrongSigner);
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(SessionError::BadSignatureInstruction)?;
    require!(msg == expected, SessionError::WrongReceipt);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    /// Key that signs receipts. Can be a short-lived agent key, so the wallet's own key never signs per call.
    pub signer: Pubkey,
    pub nonce: u64,
    pub deposit: u64,
    pub redeemed: u64,
    pub expires_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Slot this session was opened in: identifies this lifetime of the address in receipts.
    pub opened_slot: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: only recorded as the payee; it never signs here.
    pub seller: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = buyer, space = 8 + Session::INIT_SPACE, seeds = [b"session", buyer.key().as_ref(), seller.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub session: Account<'info, Session>,
    #[account(init, payer = buyer, seeds = [b"vault", session.key().as_ref()], bump, token::mint = mint, token::authority = session, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TopUp<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ SessionError::Unauthorized, has_one = mint)]
    pub session: Account<'info, Session>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", session.key().as_ref()], bump = session.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ SessionError::Unauthorized, has_one = mint)]
    pub session: Account<'info, Session>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", session.key().as_ref()], bump = session.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    pub caller: Signer<'info>,
    /// CHECK: receives the session's and vault's rent; must be the recorded buyer.
    #[account(mut, address = session.buyer @ SessionError::Unauthorized)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, close = buyer, has_one = mint)]
    pub session: Account<'info, Session>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", session.key().as_ref()], bump = session.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = session.buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct SessionOpened {
    pub session: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub deposit: u64,
    pub expires_at: i64,
}
#[event]
pub struct SessionToppedUp {
    pub session: Pubkey,
    pub amount: u64,
    pub deposit: u64,
}
#[event]
pub struct SessionRedeemed {
    pub session: Pubkey,
    pub amount: u64,
    pub cumulative: u64,
}
#[event]
pub struct SessionClosed {
    pub session: Pubkey,
    pub refund: u64,
    pub redeemed: u64,
    pub by: Pubkey,
}

#[error_code]
pub enum SessionError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Session must last at least 15 minutes")]
    DurationTooShort,
    #[msg("Session can last at most 30 days")]
    DurationTooLong,
    #[msg("Buyer and seller must differ")]
    BuyerIsSeller,
    #[msg("Session has expired")]
    Expired,
    #[msg("Session hasn't expired yet")]
    NotExpired,
    #[msg("Only the session's buyer or seller can do that")]
    Unauthorized,
    #[msg("Cumulative amount must be greater than what was already redeemed")]
    NotIncreasing,
    #[msg("Cumulative amount exceeds the deposit")]
    ExceedsDeposit,
    #[msg("Redeem must directly follow an ed25519 signature instruction")]
    MissingSignatureInstruction,
    #[msg("Malformed ed25519 instruction: exactly one signature, with all data inside that instruction")]
    BadSignatureInstruction,
    #[msg("Receipt wasn't signed by the session's signer")]
    WrongSigner,
    #[msg("Signed receipt doesn't match this program, session and amount")]
    WrongReceipt,
    #[msg("Arithmetic overflow")]
    Overflow,
}
