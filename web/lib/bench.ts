import devnet from "@/data/bench/devnet-2026-11-23.json";
import devnetRaw from "@/data/bench/devnet-2026-11-23-raw.json";
import gateway from "@/data/bench/arc-gateway-2026-11-23.json";
import localnet from "@/data/bench/localnet-2026-11-19.json";

/** Measured benchmark runs (copied from bench/results by `pnpm sync-data`). */
export const BENCH = { devnet, devnetRaw, gateway, localnet };

export const usdc = (atomic: string | number | bigint) => (Number(atomic) / 1e6).toFixed(6);
export const lamportsToSol = (l: string | number) => Number(l) / 1e9;
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)} s` : `${ms} ms`);
export const fmtInt = (n: number | string) => Number(n).toLocaleString("en-US");
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
export const txId = (url: string) => url.match(/tx\/([^?]+)/)?.[1] ?? url;
