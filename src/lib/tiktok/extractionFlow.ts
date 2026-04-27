import type { DensityTier, TemporalDensityResult } from "./density";
import type { ArchiveEvent } from "./types";

/**
 * Extraction-flow metrics and timeline bucketing.
 *
 * Motivation. The paper's claim is that TikTok-class feeds industrialize
 * micro-behavior — many gestures per minute, rapid feedback, high-dimensional
 * time series. The archive-level surplus score summarizes that claim as a
 * number; this module makes it *visible as a rate*. Every metric below is
 * computed deterministically from `events[].at` and the existing density
 * output, with no new inference about TikTok's internals.
 *
 * Claim framing: "signal-events received by TikTok from you" is honest because
 * these rows exist in the export exactly because TikTok held them; we are not
 * claiming anything about how they were stored, indexed, or used internally.
 */

export const EXTRACTION_FLOW_MODEL_VERSION = "extraction-flow-v1";

/** Gap (in minutes) between consecutive dated events that starts a new session. */
export const SESSION_GAP_MINUTES = 30;

export type ExtractionFlowMetrics = {
  /** Total dated events in the archive (= density.datedEventCount). */
  totalSignalEvents: number;
  /** events / minute at the archive's densest trailing window. */
  peakEventsPerMinute: number;
  /** Peak trailing window span in minutes (= density.windowMinutes). */
  peakWindowMinutes: number;
  /** Event count inside the peak trailing window (= density.peakTrailingWindow.count). */
  peakWindowEventCount: number;
  /** ISO start/end of the peak trailing window, or null if no dated events. */
  peakWindowStart: string | null;
  peakWindowEnd: string | null;
  /**
   * Number of distinct UTC minutes (floor-bucketed to 60s) that contain at
   * least one event classified in the `high` density tier. This is a
   * conservative, union-based count of "time spent in high-density extraction."
   */
  highDensityMinutes: number;
  /** Session count: runs of events separated by gaps > SESSION_GAP_MINUTES. */
  sessionCount: number;
  /** Median session length in minutes (end - start per session). */
  medianSessionMinutes: number;
  /** Longest single session span in minutes. */
  maxSessionMinutes: number;
};

export type TimelineBucket = {
  /** UTC date in YYYY-MM-DD form. */
  day: string;
  /** Unix epoch millis at 00:00 UTC that day, for chart positioning. */
  epochMs: number;
  /** Count of dated events on that day. */
  count: number;
  /** Count of dated events on that day whose density tier was `high`. */
  highTierCount: number;
};

export type ExtractionFlowResult = {
  modelVersion: typeof EXTRACTION_FLOW_MODEL_VERSION;
  metrics: ExtractionFlowMetrics;
  timeline: TimelineBucket[];
  evidenceBasis: string;
  claimBoundary: string;
};

function toUtcDayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function dayEpochMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeExtractionFlow(
  events: ArchiveEvent[],
  density: TemporalDensityResult,
): ExtractionFlowResult {
  const dated = events
    .filter((e): e is ArchiveEvent & { at: string } => Boolean(e.at))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const totalSignalEvents = dated.length;
  const peakWindowEventCount = density.peakTrailingWindow?.count ?? 0;
  const peakWindowMinutes = density.windowMinutes;
  const peakEventsPerMinute =
    peakWindowMinutes > 0 ? Number((peakWindowEventCount / peakWindowMinutes).toFixed(2)) : 0;

  // High-density minutes: union of distinct UTC-minute buckets touched by
  // any event whose trailing density tier is `high`.
  const highMinuteSet = new Set<number>();
  for (const ev of dated) {
    const tier: DensityTier = density.tierByEventId[ev.id] ?? "unknown";
    if (tier !== "high") continue;
    const minuteBucket = Math.floor(Date.parse(ev.at) / 60000);
    highMinuteSet.add(minuteBucket);
  }
  const highDensityMinutes = highMinuteSet.size;

  // Sessions: walk in time order, break when gap > SESSION_GAP_MINUTES.
  const GAP_MS = SESSION_GAP_MINUTES * 60 * 1000;
  const sessionSpans: number[] = [];
  let sessionStartMs: number | null = null;
  let lastMs: number | null = null;
  for (const ev of dated) {
    const ms = Date.parse(ev.at);
    if (sessionStartMs === null || lastMs === null) {
      sessionStartMs = ms;
    } else if (ms - lastMs > GAP_MS) {
      sessionSpans.push((lastMs - sessionStartMs) / 60000);
      sessionStartMs = ms;
    }
    lastMs = ms;
  }
  if (sessionStartMs !== null && lastMs !== null) {
    sessionSpans.push((lastMs - sessionStartMs) / 60000);
  }
  const sessionCount = sessionSpans.length;
  const medianSessionMinutes = Number(median(sessionSpans).toFixed(1));
  const maxSessionMinutes = sessionSpans.length
    ? Number(Math.max(...sessionSpans).toFixed(1))
    : 0;

  // Daily buckets.
  const bucketMap = new Map<string, { count: number; highTierCount: number }>();
  for (const ev of dated) {
    const day = toUtcDayKey(ev.at);
    const tier: DensityTier = density.tierByEventId[ev.id] ?? "unknown";
    const entry = bucketMap.get(day) ?? { count: 0, highTierCount: 0 };
    entry.count += 1;
    if (tier === "high") entry.highTierCount += 1;
    bucketMap.set(day, entry);
  }
  const timeline: TimelineBucket[] = Array.from(bucketMap.entries())
    .map(([day, v]) => ({
      day,
      epochMs: dayEpochMs(day),
      count: v.count,
      highTierCount: v.highTierCount,
    }))
    .sort((a, b) => a.epochMs - b.epochMs);

  const metrics: ExtractionFlowMetrics = {
    totalSignalEvents,
    peakEventsPerMinute,
    peakWindowMinutes,
    peakWindowEventCount,
    peakWindowStart: density.peakTrailingWindow?.startIso ?? null,
    peakWindowEnd: density.peakTrailingWindow?.endIso ?? null,
    highDensityMinutes,
    sessionCount,
    medianSessionMinutes,
    maxSessionMinutes,
  };

  const evidenceBasis =
    `${totalSignalEvents} dated signal-events across ${timeline.length} UTC days; ` +
    `peak ${peakWindowEventCount} events in a ${peakWindowMinutes}-min trailing window ` +
    `(${peakEventsPerMinute} events/min); ${highDensityMinutes} distinct UTC minutes spent at the ` +
    `high density tier; ${sessionCount} sessions (30-min gap rule), longest ${maxSessionMinutes} min.`;

  const claimBoundary =
    "Describes the rate and timing of signals disclosed in your export. Does not claim how " +
    "any given signal was stored, indexed, or used by TikTok internally, and does not infer " +
    "emotional state from timing.";

  return {
    modelVersion: EXTRACTION_FLOW_MODEL_VERSION,
    metrics,
    timeline,
    evidenceBasis,
    claimBoundary,
  };
}
