/** A labelled usage bar for amounts in micro-USDC. */
export function Meter({ label, used, total, color = "var(--accent)" }: { label: string; used: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-xs text-muted tabular-nums">
          {(used / 1e6).toFixed(3)} / {(total / 1e6).toFixed(3)} USDC
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
