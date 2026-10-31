import { sparklinePath } from "@/lib/monitor/price";

export function Sparkline({ points }: { points: Array<{ tradeDate: string; close: number; currency: string }> }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.close);
  const first = values[0]!;
  const last = values.at(-1)!;
  const change = ((last - first) / first) * 100;
  const up = change >= 0;
  return (
    <div className="flex items-center justify-end gap-2" title={`${points[0]!.tradeDate} to ${points.at(-1)!.tradeDate}`}>
      <svg width="96" height="28" viewBox="0 0 96 28" role="img" aria-label={`Share price over ${points.length} trading days`}>
        <path d={sparklinePath(values, 96, 28)} fill="none" stroke={up ? "#047857" : "#b91c1c"} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="text-right leading-tight">
        <div className="tabular text-sm font-medium text-slate-900">
          {points.at(-1)!.currency} {last.toFixed(2)}
        </div>
        <div className={`tabular text-[11px] ${up ? "text-emerald-700" : "text-red-700"}`}>
          {up ? "+" : ""}
          {change.toFixed(1)}% over {points.length} days
        </div>
      </div>
    </div>
  );
}
