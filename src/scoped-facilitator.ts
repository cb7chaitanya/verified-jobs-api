import type { FacilitatorClient } from "@x402/core/server";

type Kind = { scheme: string; network: string };

/**
 * Limit a facilitator to the (scheme, network) pairs this server uses it for. x402ResourceServer
 * routes each payment to the first facilitator whose getSupported() lists it (and falls back to
 * others), so without this a facilitator advertising extra networks, or wildcards, could receive
 * payments meant for another one (e.g. Solana exact payments bypassing ConfirmingFacilitator).
 */
export function scoped(inner: FacilitatorClient, allowed: Kind[]): FacilitatorClient {
  const ok = (k: { scheme?: string; network?: string }) => allowed.some((a) => a.scheme === k.scheme && a.network === k.network);
  return {
    async getSupported() {
      const s = await inner.getSupported();
      return { ...s, kinds: s.kinds.filter(ok) };
    },
    async verify(p, r) {
      if (!ok(r)) return { isValid: false, invalidReason: "unsupported_scheme", invalidMessage: `This facilitator doesn't handle ${r.scheme} on ${r.network}` };
      return inner.verify(p, r);
    },
    async settle(p, r) {
      if (!ok(r)) return { success: false, errorReason: "unsupported_scheme", errorMessage: `This facilitator doesn't handle ${r.scheme} on ${r.network}`, transaction: "", network: r.network };
      return inner.settle(p, r);
    },
  };
}
