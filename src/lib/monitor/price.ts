import type { Importance } from "@/lib/domain/enums";

export interface ClosePoint {
  tradeDate: string;
  close: number;
}

export interface PriceMove {
  tradeDate: string;
  close: number;
  dayChangePct: number;
  vs30dPct: number | null;
  importance: Importance;
  title: string;
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;

/**
 * A move worth a signal: 5% or more in a day, or 10% or more against the 30-day average.
 * 10% in a day is high importance. Rules, not the model: a number either moved or it didn't.
 */
export function detectPriceMove(points: ClosePoint[], companyName: string): PriceMove | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const last = sorted.at(-1)!;
  const prev = sorted.at(-2)!;
  if (prev.close <= 0) return null;
  const day = pct(last.close, prev.close);
  const window = sorted.slice(-31, -1);
  const avg = window.length >= 10 ? window.reduce((s, p) => s + p.close, 0) / window.length : null;
  const vs30 = avg ? pct(last.close, avg) : null;
  if (Math.abs(day) < 5 && (vs30 === null || Math.abs(vs30) < 10)) return null;
  const importance: Importance = Math.abs(day) >= 10 ? "high" : "medium";
  const dir = day >= 0 ? "up" : "down";
  return {
    tradeDate: last.tradeDate,
    close: last.close,
    dayChangePct: Math.round(day * 10) / 10,
    vs30dPct: vs30 === null ? null : Math.round(vs30 * 10) / 10,
    importance,
    title: `${companyName} shares ${dir} ${Math.abs(Math.round(day * 10) / 10)}% on ${last.tradeDate}`,
  };
}

/** SVG path for a sparkline in a width x height box. Pure, so it's tested and renders server-side. */
export function sparklinePath(values: number[], width: number, height: number, pad = 2): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (height - pad * 2) * (1 - (v - min) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
