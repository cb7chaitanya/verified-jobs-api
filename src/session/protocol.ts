/**
 * Wire format shared by the `pay_session` Solana program (solana/programs/pay_session),
 * the seller's facilitator and the buyer's client. Byte layouts here must match the Rust code.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import idl from "../../solana/idl/pay_session.json" with { type: "json" };

export const SCHEME = "session";
export const PROGRAM_ID = address(idl.address);
export const TOKEN_PROGRAM = TOKEN_PROGRAM_ADDRESS;
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
export const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");

const DOMAIN = new TextEncoder().encode("x402-session-v1\0");
const enc = getAddressEncoder();
const dec = getAddressDecoder();

const disc = (name: string) => Uint8Array.from(idl.instructions.find((i) => i.name === name)!.discriminator);
const SESSION_DISCRIMINATOR = Uint8Array.from(idl.accounts.find((a) => a.name === "Session")!.discriminator);

/** domain(16) || program(32) || session(32) || cumulative u64 LE (8) = 88 bytes. */
export function receiptMessage(program: Address, session: Address, cumulative: bigint): Uint8Array {
  const m = new Uint8Array(88);
  m.set(DOMAIN, 0);
  m.set(enc.encode(program), 16);
  m.set(enc.encode(session), 48);
  new DataView(m.buffer).setBigUint64(80, cumulative, true);
  return m;
}

export interface SessionState {
  address: Address;
  buyer: Address;
  seller: Address;
  mint: Address;
  signer: Address;
  nonce: bigint;
  deposit: bigint;
  redeemed: bigint;
  expiresAt: number; // unix seconds
}

/** Decode a Session account (8-byte discriminator + fields in declaration order). Returns null if it isn't one. */
export function decodeSession(addr: Address, data: Uint8Array): SessionState | null {
  if (data.length < 8 + 32 * 4 + 8 * 4 + 2) return null;
  if (!SESSION_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (o: number) => dec.decode(data.subarray(o, o + 32));
  return {
    address: addr,
    buyer: key(8),
    seller: key(40),
    mint: key(72),
    signer: key(104),
    nonce: dv.getBigUint64(136, true),
    deposit: dv.getBigUint64(144, true),
    redeemed: dv.getBigUint64(152, true),
    expiresAt: Number(dv.getBigInt64(160, true)),
  };
}

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const i64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

export async function sessionAddress(buyer: Address, seller: Address, nonce: bigint, program = PROGRAM_ID): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode("session"), enc.encode(buyer), enc.encode(seller), u64(nonce)] });
  return pda;
}
export async function vaultAddress(session: Address, program = PROGRAM_ID): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode("vault"), enc.encode(session)] });
  return pda;
}

// --- ed25519 with raw 32-byte keys (Solana keypair files are seed(32) || pubkey(32)) ---

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function verifyEd25519(pubkey: Address, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(enc.encode(pubkey))]), format: "der", type: "spki" });
  return edVerify(null, message, key, signature);
}

/** A receipt-signing key held in memory (e.g. a short-lived agent key, never the wallet's main key). */
export class ReceiptSigner {
  readonly address: Address;
  private readonly key;
  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) throw new Error("Expected a 64-byte Solana secret key");
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
    this.address = dec.decode(secretKey.subarray(32));
    const derived = dec.decode(new Uint8Array(createPublicKey(this.key).export({ format: "der", type: "spki" }).subarray(12)));
    if (derived !== this.address) throw new Error("Secret key and public key don't match");
  }
  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(edSign(null, message, this.key));
  }
}

// --- instructions ---

/** Ed25519 precompile instruction with signature, key and message inline (offsets = "this instruction"). */
export function ed25519Instruction(pubkey: Address, signature: Uint8Array, message: Uint8Array): Instruction {
  const header = new Uint8Array(16);
  const dv = new DataView(header.buffer);
  header[0] = 1;
  const SAME = 0xffff;
  [48, SAME, 16, SAME, 112, message.length, SAME].forEach((v, i) => dv.setUint16(2 + i * 2, v, true));
  return { programAddress: ED25519_PROGRAM, accounts: [], data: concat(header, enc.encode(pubkey) as Uint8Array, signature, message) };
}

export function redeemInstruction(a: { seller: Address; session: Address; mint: Address; vault: Address; sellerToken: Address }, cumulative: bigint): Instruction {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: a.seller, role: AccountRole.READONLY_SIGNER },
      { address: a.session, role: AccountRole.WRITABLE },
      { address: a.mint, role: AccountRole.READONLY },
      { address: a.vault, role: AccountRole.WRITABLE },
      { address: a.sellerToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    ],
    data: concat(disc("redeem"), u64(cumulative)),
  };
}

export function openSessionInstruction(
  a: { buyer: Address; seller: Address; mint: Address; buyerToken: Address; session: Address; vault: Address },
  args: { nonce: bigint; deposit: bigint; expiresAt: bigint; signer: Address },
): Instruction {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: a.buyer, role: AccountRole.WRITABLE_SIGNER },
      { address: a.seller, role: AccountRole.READONLY },
      { address: a.mint, role: AccountRole.READONLY },
      { address: a.buyerToken, role: AccountRole.WRITABLE },
      { address: a.session, role: AccountRole.WRITABLE },
      { address: a.vault, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(disc("open_session"), u64(args.nonce), u64(args.deposit), i64(args.expiresAt), enc.encode(args.signer) as Uint8Array),
  };
}

export function closeSessionInstruction(a: { caller: Address; buyer: Address; session: Address; mint: Address; vault: Address; buyerToken: Address }): Instruction {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: a.caller, role: AccountRole.READONLY_SIGNER },
      { address: a.buyer, role: AccountRole.WRITABLE },
      { address: a.session, role: AccountRole.WRITABLE },
      { address: a.mint, role: AccountRole.READONLY },
      { address: a.vault, role: AccountRole.WRITABLE },
      { address: a.buyerToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: disc("close_session"),
  };
}
