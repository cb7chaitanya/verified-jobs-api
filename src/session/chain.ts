import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { decodeSession, PROGRAM_ID, type SessionState } from "./protocol";
import type { SessionReader } from "./facilitator";

export type Rpc = ReturnType<typeof createSolanaRpc>;

export function connect(rpcUrl: string, wsUrl?: string) {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl ?? rpcUrl.replace(/^http/, "ws").replace(/:8899\b/, ":8900"));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  return {
    rpc,
    /** Sign with the fee payer (and any signer roles in the instructions), send, wait for confirmation. */
    async send(payer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      const tx = await signTransactionMessageWithSigners(msg);
      await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
      return getSignatureFromTransaction(tx);
    },
  };
}

/** CAIP-2 network id for a Solana cluster: "solana:" + first 32 chars of its genesis hash. */
export async function caip2(rpc: Rpc): Promise<`solana:${string}`> {
  const hash = await rpc.getGenesisHash().send();
  return `solana:${hash.slice(0, 32)}`;
}

/** Reads session accounts over RPC, with a short cache so a burst of calls costs one lookup. */
export class RpcSessionReader implements SessionReader {
  private cache = new Map<string, { at: number; value: SessionState | null }>();
  constructor(
    private readonly rpc: Rpc,
    private readonly ttlMs = 3000,
  ) {}
  async get(session: Address): Promise<SessionState | null> {
    const hit = this.cache.get(session);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const { value } = await this.rpc.getAccountInfo(session, { encoding: "base64", commitment: "confirmed" }).send();
    const state = value && value.owner === PROGRAM_ID ? decodeSession(session, new Uint8Array(getBase64Encoder().encode(value.data[0]))) : null;
    this.cache.set(session, { at: Date.now(), value: state });
    return state;
  }
  forget(session: Address) {
    this.cache.delete(session);
  }
}

export const asAddress = (s: string) => address(s);
