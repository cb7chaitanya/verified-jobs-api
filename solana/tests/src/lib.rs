//! Runs the compiled program in LiteSVM: target/deploy/pay_session.so, or the file named by
//! PAY_SESSION_SO. Build it first: `anchor build` (or `cargo build-sbf`).

use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use pay_session::{receipt_message, Session};
use solana_sdk::{
    clock::Clock,
    instruction::Instruction,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, sysvar,
    transaction::Transaction,
};

const USDC: u64 = 1_000_000; // 6 decimals
const DEPOSIT: u64 = 5 * USDC;
const HOUR: i64 = 3600;

struct Env {
    svm: LiteSVM,
    buyer: Keypair,
    seller: Keypair,
    /// Short-lived key the buyer's agent signs receipts with.
    agent: Keypair,
    mint: Pubkey,
    buyer_token: Pubkey,
    seller_token: Pubkey,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    r
}

fn token_account(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let acct = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
    send(
        svm,
        &[
            system_instruction::create_account(&payer.pubkey(), &acct.pubkey(), rent, spl_token::state::Account::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_account3(&spl_token::ID, &acct.pubkey(), mint, owner).unwrap(),
        ],
        payer,
        &[&acct],
    )
    .unwrap();
    acct.pubkey()
}

fn balance(svm: &LiteSVM, acct: &Pubkey) -> u64 {
    spl_token::state::Account::unpack(&svm.get_account(acct).unwrap().data).unwrap().amount
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// Move to a later slot, as consecutive transactions on a real cluster would.
fn next_slot(svm: &mut LiteSVM) {
    let mut c = svm.get_sysvar::<Clock>();
    c.slot += 1;
    svm.set_sysvar(&c);
}

fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut c = svm.get_sysvar::<Clock>();
    c.unix_timestamp += secs;
    svm.set_sysvar(&c);
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let so_path = std::env::var("PAY_SESSION_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/pay_session.so").to_string());
    let so = std::fs::read(&so_path).unwrap_or_else(|e| panic!("read {so_path}: {e} (build the program first)"));
    svm.add_program(pay_session::ID, &so);
    let (buyer, seller, agent) = (Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&buyer, &seller] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    send(
        &mut svm,
        &[
            system_instruction::create_account(&buyer.pubkey(), &mint.pubkey(), rent, spl_token::state::Mint::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &buyer.pubkey(), None, 6).unwrap(),
        ],
        &buyer,
        &[&mint],
    )
    .unwrap();
    let buyer_token = token_account(&mut svm, &buyer, &mint.pubkey(), &buyer.pubkey());
    let seller_token = token_account(&mut svm, &seller, &mint.pubkey(), &seller.pubkey());
    send(&mut svm, &[spl_token::instruction::mint_to(&spl_token::ID, &mint.pubkey(), &buyer_token, &buyer.pubkey(), &[], 20 * USDC).unwrap()], &buyer, &[]).unwrap();
    Env { svm, buyer, seller, agent, mint: mint.pubkey(), buyer_token, seller_token }
}

fn pdas(e: &Env, nonce: u64) -> (Pubkey, Pubkey) {
    let (session, _) = Pubkey::find_program_address(&[b"session", e.buyer.pubkey().as_ref(), e.seller.pubkey().as_ref(), &nonce.to_le_bytes()], &pay_session::ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", session.as_ref()], &pay_session::ID);
    (session, vault)
}

fn open(e: &mut Env, nonce: u64, deposit: u64, duration: i64) -> Result<Pubkey, String> {
    let (session, vault) = pdas(e, nonce);
    let expires_at = now(&e.svm) + duration;
    let ix = Instruction {
        program_id: pay_session::ID,
        accounts: pay_session::accounts::OpenSession {
            buyer: e.buyer.pubkey(),
            seller: e.seller.pubkey(),
            mint: e.mint,
            buyer_token: e.buyer_token,
            session,
            vault,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: pay_session::instruction::OpenSession { nonce, deposit, expires_at, signer: e.agent.pubkey() }.data(),
    };
    let buyer = e.buyer.insecure_clone();
    send(&mut e.svm, &[ix], &buyer, &[]).map(|_| session)
}

/// Ed25519 precompile instruction with all data inline. `ix_index` overrides the
/// "same instruction" marker (u16::MAX) to model offsets that point elsewhere.
fn ed25519_ix(pubkey: &Pubkey, sig: &[u8; 64], msg: &[u8], ix_index: u16) -> Instruction {
    let (pk_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
    let mut d = vec![1u8, 0];
    for v in [sig_off, ix_index, pk_off, ix_index, msg_off, msg.len() as u16, ix_index] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(pubkey.as_ref());
    d.extend_from_slice(sig);
    d.extend_from_slice(msg);
    Instruction { program_id: solana_sdk::ed25519_program::ID, accounts: vec![], data: d }
}

/// A receipt for `cumulative`, bound to the session's current lifetime (the slot it was opened in).
fn signed_receipt(e: &Env, signer: &Keypair, session: &Pubkey, cumulative: u64) -> ([u8; 64], Vec<u8>) {
    let opened_slot = session_state(e, session).opened_slot;
    let msg = receipt_message(&pay_session::ID, session, opened_slot, cumulative).to_vec();
    let sig: [u8; 64] = signer.sign_message(&msg).as_ref().try_into().unwrap();
    (sig, msg)
}

fn redeem_ix(e: &Env, session: &Pubkey, redeemer: &Pubkey, cumulative: u64) -> Instruction {
    let (vault, _) = Pubkey::find_program_address(&[b"vault", session.as_ref()], &pay_session::ID);
    Instruction {
        program_id: pay_session::ID,
        accounts: pay_session::accounts::Redeem { seller: *redeemer, session: *session, mint: e.mint, vault, seller_token: e.seller_token, token_program: spl_token::ID, instructions: sysvar::instructions::ID }
            .to_account_metas(None),
        data: pay_session::instruction::Redeem { cumulative }.data(),
    }
}

/// The happy path: the agent's receipt for `cumulative`, redeemed by the seller.
fn redeem(e: &mut Env, session: &Pubkey, cumulative: u64) -> Result<(), String> {
    let (sig, msg) = signed_receipt(e, &e.agent, session, cumulative);
    let ixs = [ed25519_ix(&e.agent.pubkey(), &sig, &msg, u16::MAX), redeem_ix(e, session, &e.seller.pubkey(), cumulative)];
    let seller = e.seller.insecure_clone();
    send(&mut e.svm, &ixs, &seller, &[])
}

fn close_ix(e: &Env, session: &Pubkey, caller: &Pubkey) -> Instruction {
    let (vault, _) = Pubkey::find_program_address(&[b"vault", session.as_ref()], &pay_session::ID);
    Instruction {
        program_id: pay_session::ID,
        accounts: pay_session::accounts::CloseSession { caller: *caller, buyer: e.buyer.pubkey(), session: *session, mint: e.mint, vault, buyer_token: e.buyer_token, token_program: spl_token::ID }.to_account_metas(None),
        data: pay_session::instruction::CloseSession {}.data(),
    }
}

fn session_state(e: &Env, session: &Pubkey) -> Session {
    let a = e.svm.get_account(session).unwrap();
    anchor_lang::AccountDeserialize::try_deserialize(&mut a.data.as_slice()).unwrap()
}

fn assert_err(r: Result<(), String>, code: &str) {
    let msg = r.expect_err(&format!("expected {code}"));
    assert!(msg.contains(code), "expected {code}, got:\n{msg}");
}

#[test]
fn redeems_receipts_incrementally_and_never_twice() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    assert_eq!(balance(&e.svm, &e.buyer_token), 15 * USDC);

    // 1,000 calls at $0.001 = $1, redeemed with one transaction.
    redeem(&mut e, &s, 1_000 * 1_000).unwrap();
    assert_eq!(balance(&e.svm, &e.seller_token), USDC);
    // Later receipt: only the difference moves.
    redeem(&mut e, &s, 1_500 * 1_000).unwrap();
    assert_eq!(balance(&e.svm, &e.seller_token), 1_500_000);
    assert_eq!(session_state(&e, &s).redeemed, 1_500_000);

    // Replaying an old or the same receipt does nothing but fail.
    assert_err(redeem(&mut e, &s, 1_500_000), "NotIncreasing");
    assert_err(redeem(&mut e, &s, 1_000_000), "NotIncreasing");
    assert_eq!(balance(&e.svm, &e.seller_token), 1_500_000);
}

#[test]
fn never_pays_out_more_than_the_deposit() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    assert_err(redeem(&mut e, &s, DEPOSIT + 1), "ExceedsDeposit");
    redeem(&mut e, &s, DEPOSIT).unwrap();
    assert_eq!(balance(&e.svm, &e.seller_token), DEPOSIT);
}

#[test]
fn rejects_receipts_signed_by_anyone_but_the_session_signer() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    // A valid signature, but by the buyer's main key rather than the session's agent key.
    let (sig, msg) = signed_receipt(&e, &e.buyer, &s, 100);
    let ixs = [ed25519_ix(&e.buyer.pubkey(), &sig, &msg, u16::MAX), redeem_ix(&e, &s, &e.seller.pubkey(), 100)];
    let seller = e.seller.insecure_clone();
    assert_err(send(&mut e.svm, &ixs, &seller, &[]), "WrongSigner");
}

#[test]
fn rejects_a_receipt_meant_for_another_session() {
    let mut e = setup();
    let s1 = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let s2 = open(&mut e, 2, DEPOSIT, HOUR).unwrap();
    let (sig, msg) = signed_receipt(&e, &e.agent, &s1, 100);
    let ixs = [ed25519_ix(&e.agent.pubkey(), &sig, &msg, u16::MAX), redeem_ix(&e, &s2, &e.seller.pubkey(), 100)];
    let seller = e.seller.insecure_clone();
    assert_err(send(&mut e.svm, &ixs, &seller, &[]), "WrongReceipt");
}

#[test]
fn requires_the_signature_check_right_before_redeem() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let seller = e.seller.insecure_clone();
    let ix = redeem_ix(&e, &s, &e.seller.pubkey(), 100);
    assert_err(send(&mut e.svm, &[ix], &seller, &[]), "MissingSignatureInstruction");
}

#[test]
fn rejects_signature_offsets_that_point_outside_the_ed25519_instruction() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    // Explicit index 0 instead of "this instruction": the precompile still verifies (index 0 is
    // itself here), but the program must refuse any layout where verified bytes could live elsewhere.
    let (sig, msg) = signed_receipt(&e, &e.agent, &s, 100);
    let ixs = [ed25519_ix(&e.agent.pubkey(), &sig, &msg, 0), redeem_ix(&e, &s, &e.seller.pubkey(), 100)];
    let seller = e.seller.insecure_clone();
    assert_err(send(&mut e.svm, &ixs, &seller, &[]), "BadSignatureInstruction");
}

#[test]
fn a_forged_signature_fails_in_the_precompile() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let (mut sig, msg) = signed_receipt(&e, &e.agent, &s, 100);
    sig[0] ^= 0xff;
    let ixs = [ed25519_ix(&e.agent.pubkey(), &sig, &msg, u16::MAX), redeem_ix(&e, &s, &e.seller.pubkey(), 100)];
    let seller = e.seller.insecure_clone();
    let r = send(&mut e.svm, &ixs, &seller, &[]);
    assert!(r.is_err(), "a corrupted signature must not redeem");
    assert_eq!(balance(&e.svm, &e.seller_token), 0);
}

#[test]
fn only_the_seller_can_redeem() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let (sig, msg) = signed_receipt(&e, &e.agent, &s, 100);
    let ixs = [ed25519_ix(&e.agent.pubkey(), &sig, &msg, u16::MAX), redeem_ix(&e, &s, &e.buyer.pubkey(), 100)];
    let buyer = e.buyer.insecure_clone();
    assert_err(send(&mut e.svm, &ixs, &buyer, &[]), "Unauthorized");
}

#[test]
fn buyer_gets_the_unredeemed_balance_back_only_after_expiry() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    redeem(&mut e, &s, 2 * USDC).unwrap();
    let buyer = e.buyer.insecure_clone();
    let ix = close_ix(&e, &s, &e.buyer.pubkey());
    assert_err(send(&mut e.svm, &[ix.clone()], &buyer, &[]), "NotExpired");

    warp(&mut e.svm, HOUR);
    send(&mut e.svm, &[ix], &buyer, &[]).unwrap();
    assert_eq!(balance(&e.svm, &e.buyer_token), 15 * USDC + 3 * USDC); // deposit 5, seller took 2
    assert_eq!(balance(&e.svm, &e.seller_token), 2 * USDC);
    assert!(e.svm.get_account(&s).map_or(true, |a| a.lamports == 0), "session account closed");
}

#[test]
fn seller_can_close_early_and_refunds_the_buyer() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    redeem(&mut e, &s, USDC).unwrap();
    let seller = e.seller.insecure_clone();
    let ix = close_ix(&e, &s, &e.seller.pubkey());
    send(&mut e.svm, &[ix], &seller, &[]).unwrap();
    assert_eq!(balance(&e.svm, &e.buyer_token), 15 * USDC + 4 * USDC);
}

#[test]
fn strangers_cannot_close() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    warp(&mut e.svm, HOUR);
    let ix = close_ix(&e, &s, &stranger.pubkey());
    assert_err(send(&mut e.svm, &[ix], &stranger, &[]), "Unauthorized");
}

#[test]
fn top_up_extends_what_can_be_redeemed() {
    let mut e = setup();
    let s = open(&mut e, 1, DEPOSIT, HOUR).unwrap();
    let (_, vault) = pdas(&e, 1);
    let ix = Instruction {
        program_id: pay_session::ID,
        accounts: pay_session::accounts::TopUp { buyer: e.buyer.pubkey(), session: s, mint: e.mint, buyer_token: e.buyer_token, vault, token_program: spl_token::ID }.to_account_metas(None),
        data: pay_session::instruction::TopUp { amount: 3 * USDC }.data(),
    };
    let buyer = e.buyer.insecure_clone();
    send(&mut e.svm, &[ix], &buyer, &[]).unwrap();
    assert_eq!(session_state(&e, &s).deposit, 8 * USDC);
    redeem(&mut e, &s, 7 * USDC).unwrap();
    assert_eq!(balance(&e.svm, &e.seller_token), 7 * USDC);
}

#[test]
fn sessions_must_leave_time_to_redeem() {
    let mut e = setup();
    assert_err(open(&mut e, 1, DEPOSIT, 60).map(|_| ()), "DurationTooShort");
    assert_err(open(&mut e, 2, DEPOSIT, 31 * 24 * HOUR).map(|_| ()), "DurationTooLong");
    assert_err(open(&mut e, 3, 0, HOUR).map(|_| ()), "ZeroAmount");
}

#[test]
fn a_reopened_session_does_not_accept_receipts_from_its_earlier_lifetime() {
    // Same buyer, seller, nonce and agent key: the session PDA is the same address both times.
    let mut e = setup();
    let s = open(&mut e, 7, DEPOSIT, 2 * HOUR).unwrap();
    let (sig, msg) = signed_receipt(&e, &e.agent, &s, 2 * USDC);
    let old_ed = ed25519_ix(&e.agent.pubkey(), &sig, &msg, u16::MAX);
    let first = [old_ed.clone(), redeem_ix(&e, &s, &e.seller.pubkey(), 2 * USDC)];
    let seller = e.seller.insecure_clone();
    send(&mut e.svm, &first, &seller, &[]).unwrap();
    let close = [close_ix(&e, &s, &e.seller.pubkey())];
    send(&mut e.svm, &close, &seller, &[]).unwrap();
    next_slot(&mut e.svm);
    let again = open(&mut e, 7, DEPOSIT, 2 * HOUR).unwrap();
    assert_eq!(again, s);
    // Replaying the first lifetime's signed receipt must not pay the seller twice.
    let replay = [old_ed, redeem_ix(&e, &s, &e.seller.pubkey(), 2 * USDC)];
    assert_err(send(&mut e.svm, &replay, &seller, &[]), "WrongReceipt");
    assert_eq!(balance(&e.svm, &e.seller_token), 2 * USDC);
    // A receipt for the new lifetime still works.
    redeem(&mut e, &s, USDC).unwrap();
    assert_eq!(balance(&e.svm, &e.seller_token), 3 * USDC);
}

// --- Token-2022 mints, built directly as account data (no extra crates needed) ---

const TOKEN_2022: Pubkey = solana_sdk::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// An initialized mint (82 bytes), optionally followed by Token-2022's account-type byte and one
/// MintCloseAuthority extension (type 3) — the shape of any mint that carries extensions.
fn token_2022_mint(svm: &mut LiteSVM, authority: &Pubkey, with_extension: bool) -> Pubkey {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[36..44].copy_from_slice(&(100 * USDC).to_le_bytes());
    d[44] = 6;
    d[45] = 1;
    if with_extension {
        d.resize(165, 0);
        d.push(1); // AccountType::Mint
        d.extend_from_slice(&3u16.to_le_bytes());
        d.extend_from_slice(&32u16.to_le_bytes());
        d.extend_from_slice(authority.as_ref());
    }
    let mint = Pubkey::new_unique();
    let lamports = svm.minimum_balance_for_rent_exemption(d.len());
    svm.set_account(mint, solana_sdk::account::Account { lamports, data: d, owner: TOKEN_2022, executable: false, rent_epoch: 0 }).unwrap();
    mint
}

/// An initialized Token-2022 token account (165 bytes, no extensions) holding `amount`.
fn token_2022_account(svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    let acct = Pubkey::new_unique();
    let lamports = svm.minimum_balance_for_rent_exemption(d.len());
    svm.set_account(acct, solana_sdk::account::Account { lamports, data: d, owner: TOKEN_2022, executable: false, rent_epoch: 0 }).unwrap();
    acct
}

fn open_with_mint(e: &mut Env, nonce: u64, mint: Pubkey, buyer_token: Pubkey, token_program: Pubkey) -> Result<Pubkey, String> {
    let (session, vault) = pdas(e, nonce);
    let ix = Instruction {
        program_id: pay_session::ID,
        accounts: pay_session::accounts::OpenSession { buyer: e.buyer.pubkey(), seller: e.seller.pubkey(), mint, buyer_token, session, vault, token_program, system_program: solana_sdk::system_program::ID }
            .to_account_metas(None),
        data: pay_session::instruction::OpenSession { nonce, deposit: USDC, expires_at: now(&e.svm) + HOUR, signer: e.agent.pubkey() }.data(),
    };
    let buyer = e.buyer.insecure_clone();
    send(&mut e.svm, &[ix], &buyer, &[]).map(|_| session)
}

#[test]
fn refuses_mints_with_token_2022_extensions() {
    let mut e = setup();
    let buyer = e.buyer.pubkey();
    let mint = token_2022_mint(&mut e.svm, &buyer, true);
    let buyer_token = token_2022_account(&mut e.svm, &mint, &buyer, 10 * USDC);
    assert_err(open_with_mint(&mut e, 30, mint, buyer_token, TOKEN_2022).map(|_| ()), "UnsupportedMint");
}

#[test]
fn accepts_a_token_2022_mint_without_extensions() {
    let mut e = setup();
    let buyer = e.buyer.pubkey();
    let mint = token_2022_mint(&mut e.svm, &buyer, false);
    let buyer_token = token_2022_account(&mut e.svm, &mint, &buyer, 10 * USDC);
    let session = open_with_mint(&mut e, 31, mint, buyer_token, TOKEN_2022).unwrap();
    let (_, vault) = pdas(&e, 31);
    let v = e.svm.get_account(&vault).unwrap();
    assert_eq!(v.owner, TOKEN_2022);
    assert_eq!(u64::from_le_bytes(v.data[64..72].try_into().unwrap()), USDC); // token amount
    assert_eq!(session_state(&e, &session).mint, mint);
}

#[test]
fn refuses_a_mint_owned_by_a_different_token_program_than_the_one_passed() {
    let mut e = setup();
    let buyer = e.buyer.pubkey();
    let mint = token_2022_mint(&mut e.svm, &buyer, false);
    let buyer_token = token_2022_account(&mut e.svm, &mint, &buyer, 10 * USDC);
    // Token-2022 mint, but the legacy token program passed in.
    assert!(open_with_mint(&mut e, 32, mint, buyer_token, spl_token::ID).is_err());
}
