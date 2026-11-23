import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { address } from "@solana/kit";
import { scoped } from "../src/scoped-facilitator";
import { RpcSessionReader } from "../src/session/chain";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ARC = "eip155:5042002";

describe("facilitator scoping", () => {
  const calls: string[] = [];
  // A facilitator that advertises more than it should (another network, a wildcard).
  const greedy: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: ARC }, { x402Version: 2, scheme: "exact", network: SOL }, { x402Version: 2, scheme: "exact", network: "solana:*" }], extensions: [], signers: {} } as never;
    },
    async verify() {
      calls.push("verify");
      return { isValid: true };
    },
    async settle() {
      calls.push("settle");
      return { success: true, transaction: "x", network: ARC };
    },
  };

  it("advertises only the pairs it's used for and refuses everything else without calling through", async () => {
    const f = scoped(greedy, [{ scheme: "exact", network: ARC }]);
    expect((await f.getSupported()).kinds).toEqual([{ x402Version: 2, scheme: "exact", network: ARC }]);
    const req = { scheme: "exact", network: SOL, asset: "a", amount: "1", payTo: "p", maxTimeoutSeconds: 60, extra: {} } as never;
    expect(await f.verify({} as never, req)).toMatchObject({ isValid: false });
    expect(await f.settle({} as never, req)).toMatchObject({ success: false });
    expect(calls).toEqual([]);
    expect(await f.verify({} as never, { ...(req as object), network: ARC } as never)).toMatchObject({ isValid: true });
  });
});

describe("session reader cache", () => {
  it("stays bounded however many distinct (unpaid) session addresses are looked up", async () => {
    let reads = 0;
    const rpc = { getAccountInfo: () => ({ send: async () => (reads++, { value: null }) }) } as never;
    const reader = new RpcSessionReader(rpc, 60_000, 10);
    const addrs = Array.from({ length: 25 }, (_, i) => address(`1111111111111111111111111111111${"ABCDEFGHJKLMNPQRSTUVWXYZa"[i]}`));
    for (const a of addrs) await reader.get(a);
    expect(reader.size).toBe(10);
    await reader.get(addrs[24]!); // recent "not found" answers are cached
    expect(reads).toBe(25);
  });
});
