import type { ArchiveEvent } from "./types";

export type DensityTier = "unknown" | "normal" | "elevated" | "high";

/**
 * Centralized density tier cutoffs and window size.
 *
 * Semantics: `high` and `elevated` are trailing-window event counts — i.e. the number of
 * dated export rows that fall inside `windowMinutes` ending at a given row's timestamp.
 * These thresholds are heuristic and content-independent: they describe how *thick* the
 * disclosed trace is in short clock time, not how important any individual row is.
 *
 * The values are snapshotted into the report's model metadata for reproducibility, so
 * changing them requires bumping the consumer's stored config (not editing silently).
 */
export const DENSITY_THRESHOLDS = {
  /**
   * Legacy absolute floor for the `high` tier. Used as a fallback when
   * the archive has too few dated events to derive stable quantiles,
   * and as a minimum bar on the adaptive thresholds so that rows in a
   * very sparse archive are not all labelled `high`.
   */
  high: 30,
  /** Legacy absolute floor for the `elevated` tier. */
  elevated: 12,
  /**
   * Quantile cutoffs used by the adaptive tier assignment. A row's
   * trailing-window count is compared to these quantiles of the user's
   * own count distribution so that tiers are meaningful regardless of
   * whether their overall scrolling is heavy or light.
   */
  highQuantile: 0.9,
  elevatedQuantile: 0.7,
  /**
   * Minimum number of dated events needed before adaptive quantiles are
   * trusted; below this we fall back to absolute thresholds so small
   * archives don't produce statistically meaningless cutoffs.
   */
  adaptiveMinEvents: 50,
  /** Default trailing-window length in minutes used by the UI and report. */
  windowMinutesDefault: 10,
} as const;

export type TemporalDensityResult = {
  windowMinutes: number;
  /** Per-event tier: trailing window count of dated events ending at this row's timestamp. */
  tierByEventId: Record<string, DensityTier>;
  /** Trailing-window event counts (same window as tiers). */
  countByEventId: Record<string, number>;
  /** Densest trailing window found in the archive (by event count). */
  peakTrailingWindow: { count: number; startIso: string; endIso: string } | null;
  datedEventCount: number;
  tierCounts: Record<DensityTier, number>;
  /**
   * The actual thresholds used for this archive (adaptive or absolute).
   * Exposed so the UI / report can cite exact cutoffs, not just
   * assume the default constants.
   */
  thresholdsUsed: {
    high: number;
    elevated: number;
    mode: "adaptive" | "absolute";
  };
  /**
   * Percentile rank of each row's count within the user's own count
   * distribution (0–100). Useful when a continuous signal is more
   * informative than a four-way categorical.
   */
  percentileByEventId: Record<string, number>;
};

function validTime(iso: string): number | null {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Measures how “thick” the behavioral trace is in short calendar time—dense streams are
 * high-leverage surplus substrate because models can update quickly from rapid micro-signals.
 */
/** Linear-interpolated quantile on an already-sorted numeric array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function analyzeTemporalDensity(
  events: ArchiveEvent[],
  windowMinutes = DENSITY_THRESHOLDS.windowMinutesDefault,
): TemporalDensityResult {
  const WINDOW_MS = windowMinutes * 60 * 1000;
  const tierByEventId: Record<string, DensityTier> = {};
  const countByEventId: Record<string, number> = {};
  const percentileByEventId: Record<string, number> = {};

  for (const e of events) {
    if (!e.at || validTime(e.at) === null) {
      tierByEventId[e.id] = "unknown";
      countByEventId[e.id] = 0;
      percentileByEventId[e.id] = 0;
    }
  }

  const dated = events
    .filter((e) => e.at && validTime(e.at) !== null)
    .map((e) => ({ id: e.id, t: validTime(e.at!)! }))
    .sort((a, b) => a.t - b.t);

  let peak: { count: number; startIso: string; endIso: string } | null = null;
  let left = 0;

  // First pass: compute windowed counts for every dated row.
  const countsInOrder: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const t = dated[i].t;
    while (left <= i && dated[left].t < t - WINDOW_MS) left += 1;
    const count = i - left + 1;
    countByEventId[dated[i].id] = count;
    countsInOrder.push(count);

    if (!peak || count > peak.count) {
      peak = {
        count,
        startIso: new Date(dated[left].t).toISOString(),
        endIso: new Date(t).toISOString(),
      };
    }
  }

  // Choose thresholds. If the archive has enough dated events, use
  // quantile-based cutoffs derived from the user's own count
  // distribution — these give useful tier differentiation regardless of
  // whether their overall scrolling is heavy or light. Below the minimum
  // sample size, fall back to the absolute legacy cutoffs.
  const sorted = [...countsInOrder].sort((a, b) => a - b);
  let highCut: number;
  let elevatedCut: number;
  let mode: "adaptive" | "absolute";
  if (dated.length >= DENSITY_THRESHOLDS.adaptiveMinEvents) {
    // Adaptive: quantiles of the user's own distribution, with an
    // absolute-minimum floor so nothing in a low-cadence archive gets
    // flagged `high` on purely relative grounds.
    highCut = Math.max(
      quantile(sorted, DENSITY_THRESHOLDS.highQuantile),
      2,
    );
    elevatedCut = Math.max(
      quantile(sorted, DENSITY_THRESHOLDS.elevatedQuantile),
      2,
    );
    // Guarantee strict ordering: elevated cut must be < high cut, and
    // both must exceed the theoretical minimum of 1 observation.
    if (elevatedCut >= highCut) elevatedCut = Math.max(1, highCut - 1);
    mode = "adaptive";
  } else {
    highCut = DENSITY_THRESHOLDS.high;
    elevatedCut = DENSITY_THRESHOLDS.elevated;
    mode = "absolute";
  }

  // Second pass: assign tier and percentile rank per row.
  for (let i = 0; i < dated.length; i++) {
    const count = countsInOrder[i];
    // Tier using the chosen cutoffs.
    if (count >= highCut) tierByEventId[dated[i].id] = "high";
    else if (count >= elevatedCut) tierByEventId[dated[i].id] = "elevated";
    else tierByEventId[dated[i].id] = "normal";
    // Percentile rank (fraction of counts ≤ this count, ×100).
    // Lower-rank via binary search on `sorted`.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= count) lo = mid + 1;
      else hi = mid;
    }
    percentileByEventId[dated[i].id] = Math.round((lo / sorted.length) * 100);
  }

  const tierCounts: Record<DensityTier, number> = {
    unknown: 0,
    normal: 0,
    elevated: 0,
    high: 0,
  };
  for (const e of events) {
    tierCounts[tierByEventId[e.id] ?? "unknown"] += 1;
  }

  return {
    windowMinutes,
    tierByEventId,
    countByEventId,
    percentileByEventId,
    peakTrailingWindow: peak,
    datedEventCount: dated.length,
    tierCounts,
    thresholdsUsed: {
      high: highCut,
      elevated: elevatedCut,
      mode,
    },
  };
}

export function densityLabel(tier: DensityTier): string {
  switch (tier) {
    case "high":
      return "High surplus density";
    case "elevated":
      return "Elevated density";
    case "normal":
      return "Typical density";
    default:
      return "Unknown density";
  }
}
