import { readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createKeyPairSignerFromBytes, getAddressDecoder, type Address } from "@solana/kit";

/** Read a Solana CLI keypair file (JSON array of 64 bytes). */
export function readKeypair(path: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path} isn't a 64-byte Solana keypair file`);
  return Uint8Array.from(bytes);
}

export const signerFrom = (path: string) => createKeyPairSignerFromBytes(readKeypair(path));

/** Create a fresh keypair file (mode 0600) and return its address. */
export function newKeypairFile(path: string): { address: Address; secret: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const secret = new Uint8Array(Buffer.concat([seed, pub]));
  writeFileSync(path, JSON.stringify([...secret]), { mode: 0o600 });
  return { address: getAddressDecoder().decode(new Uint8Array(pub)), secret };
}

/** "1.5" → 1_500_000n (USDC, 6 decimals). */
export function usdc(amount: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error(`Not a USDC amount: ${amount}`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`Missing --${name}`);
  return v;
}
