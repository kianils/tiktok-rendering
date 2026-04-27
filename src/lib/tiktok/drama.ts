import type { ArchiveEvent } from "./types";
import { extractTextForSentiment } from "./sentiment";

/**
 * TikTok-drama engagement detector.
 *
 * Motivation. A disproportionate share of behavioural-surplus extraction
 * happens around "drama" content: viral controversies, creator beef,
 * accusations, callouts, tea-spilling threads. These moments are
 * high-leverage for a recommender because they drive long sessions,
 * rapid re-engagement, and emotionally loaded text the model can cheaply
 * flatten into features. Telling the user, from their own trace, how
 * much of their archive touched this category makes the abstract
 * "rendering" argument concrete in the way most 2025 TikTok users
 * actually experience the app.
 *
 * What this module does. It scans searches, comments, and captions in
 * the user's archive for drama-adjacent keywords and regex patterns.
 * It does NOT attempt to identify which specific creator or controversy —
 * that would be both inaccurate and invasive. It only reports aggregate
 * statistics: share of drama-touching events, recurring drama themes,
 * and a few representative examples the user can verify.
 *
 * What this module does NOT claim. (1) It does not classify any
 * individual person as "drama"; keywords match text, not people. (2) It
 * does not label the user as anything; it reports what they typed and
 * what the archive contains. (3) It does not recover TikTok's actual
 * drama detection (if any); it runs a transparent lexicon over the
 * disclosed text.
 */

export const DRAMA_MODEL_VERSION = "lexicon-drama-v1";

/**
 * Keyword buckets. Multiple patterns per bucket; any match counts as a
 * hit in that bucket. Regex patterns use word boundaries so partial
 * matches do not spuriously flag unrelated rows.
 */
export const DRAMA_LEXICON: ReadonlyArray<{
  bucket: DramaBucket;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    bucket: "controversy",
    patterns: [
      /\bdrama\b/i,
      /\bcontrovers/i,
      /\bscandal\b/i,
      /\bbeef\b/i,
      /\bfeud\b/i,
      /\bfight\s+(with|between)\b/i,
    ],
  },
  {
    bucket: "callout",
    patterns: [
      /\bexposed?\b/i,
      /\bcalled?\s+out\b/i,
      /\bproblematic\b/i,
      /\bcancel(l|l?ed|l?ing)?\b/i,
      /\baccus(ed|ing|ation)/i,
      /\ballegation/i,
      /\breceipts?\b/i,
    ],
  },
  {
    bucket: "tea",
    patterns: [
      /\btea\b/i,
      /\bspill(ing)?\s+(the\s+)?tea\b/i,
      /\bwhat\s+happened\s+(with|to)\b/i,
      /\bwhat'?s\s+going\s+on\s+with\b/i,
      /\bwhy\s+is\s+\w+\s+(trend|getting)/i,
      /\bgossip\b/i,
      /\brumou?r/i,
    ],
  },
  {
    bucket: "breakup",
    patterns: [
      /\bbreakup\b/i,
      /\bsplit\b/i,
      /\bcheat(ed|ing)\b/i,
      /\baffair\b/i,
      /\bdivorce\b/i,
      /\bex[-\s]?(boyfriend|girlfriend|partner)\b/i,
    ],
  },
  {
    bucket: "apology",
    patterns: [
      /\bapology\s+video\b/i,
      /\bapologiz/i,
      /\bnotes\s+app\s+apology\b/i,
      /\baddress(ing|es|ed)\s+(the|their|his|her)\s+/i,
    ],
  },
  {
    bucket: "reaction",
    patterns: [
      /\breaction\b/i,
      /\breacting\s+to\b/i,
      /\bthoughts\s+on\b/i,
      /\btake\s+on\b/i,
      /\bweigh(ing)?\s+in\b/i,
    ],
  },
];

export type DramaBucket =
  | "controversy"
  | "callout"
  | "tea"
  | "breakup"
  | "apology"
  | "reaction";

export const DRAMA_BUCKET_LABELS: Readonly<Record<DramaBucket, string>> =
  Object.freeze({
    controversy: "Drama, beef, feuds",
    callout: "Callouts, cancellations, accusations",
    tea: "Tea, gossip, rumour searches",
    breakup: "Breakups, cheating, exes",
    apology: "Apology videos",
    reaction: "Reactions, takes, hot takes",
  });

export type DramaHit = {
  /** Stable event id from the archive. */
  eventId: string;
  /** The text the lexicon matched against. */
  text: string;
  /** Which bucket(s) matched for this event. Usually one; rarely more. */
  buckets: DramaBucket[];
  /** ISO timestamp when available. */
  at: string | null;
};

export type DramaReport = {
  modelVersion: typeof DRAMA_MODEL_VERSION;
  /** Total events scanned (those with extractable natural-language text). */
  eventsScanned: number;
  /** Events that matched at least one drama pattern. */
  dramaHits: number;
  /** Share of scanned events that touched drama. */
  dramaShare: number;
  /** Per-bucket tallies. */
  byBucket: Record<DramaBucket, number>;
  /** Up to 5 representative hits the user can verify by reading. */
  examples: DramaHit[];
  /**
   * Buckets ranked by count, with a plain-language label. Useful for
   * showing the reader which drama *categories* dominate their trace.
   */
  topBuckets: Array<{ bucket: DramaBucket; label: string; count: number }>;
  /** Human-facing summary sentence. */
  plainLanguage: string;
};

/**
 * Scan the archive for drama engagement. Uses the same text-extraction
 * path as the sentiment classifier, so a row has drama potential IFF
 * it has extractable natural-language content — non-text events are
 * excluded from the denominator too.
 */
export function computeDramaEngagement(events: ArchiveEvent[]): DramaReport {
  const byBucket: Record<DramaBucket, number> = {
    controversy: 0,
    callout: 0,
    tea: 0,
    breakup: 0,
    apology: 0,
    reaction: 0,
  };
  const hits: DramaHit[] = [];
  let eventsScanned = 0;

  for (const ev of events) {
    const text = extractTextForSentiment(ev.label, ev.rawPreview);
    if (!text) continue;
    eventsScanned += 1;

    const matched: DramaBucket[] = [];
    for (const entry of DRAMA_LEXICON) {
      if (entry.patterns.some((p) => p.test(text))) {
        matched.push(entry.bucket);
      }
    }
    if (matched.length === 0) continue;

    for (const b of matched) byBucket[b] += 1;
    hits.push({ eventId: ev.id, text, buckets: matched, at: ev.at });
  }

  const dramaHits = hits.length;
  const dramaShare = eventsScanned > 0 ? dramaHits / eventsScanned : 0;

  const topBuckets = (Object.entries(byBucket) as Array<[DramaBucket, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, count]) => ({
      bucket,
      label: DRAMA_BUCKET_LABELS[bucket],
      count,
    }));

  // Pick up to 5 representative examples: prefer hits that matched
  // multiple buckets (more drama-dense), then spread across different
  // top buckets so the user sees variety.
  const byPriority = [...hits].sort((a, b) => b.buckets.length - a.buckets.length);
  const examples: DramaHit[] = [];
  const seenBuckets = new Set<DramaBucket>();
  for (const h of byPriority) {
    if (examples.length >= 5) break;
    const newBucket = h.buckets.find((b) => !seenBuckets.has(b));
    if (newBucket || examples.length < 2) {
      examples.push(h);
      for (const b of h.buckets) seenBuckets.add(b);
    }
  }

  let plainLanguage = "No drama-adjacent engagement detected in your text content.";
  if (eventsScanned === 0) {
    plainLanguage = "Not enough natural-language content in your archive to scan.";
  } else if (dramaHits > 0) {
    const pct = Math.round(dramaShare * 100);
    const topLabel = topBuckets[0]?.label ?? "drama";
    plainLanguage = `Of ${eventsScanned.toLocaleString()} text-bearing events in your archive, ${dramaHits.toLocaleString()} (${pct}%) touched drama-adjacent content. The largest bucket was "${topLabel}" (${topBuckets[0]?.count ?? 0} events). Drama content is high-leverage for recommenders — it correlates with long sessions, rapid re-engagement, and emotionally loaded text the model can flatten cheaply.`;
  }

  return {
    modelVersion: DRAMA_MODEL_VERSION,
    eventsScanned,
    dramaHits,
    dramaShare,
    byBucket,
    examples,
    topBuckets,
    plainLanguage,
  };
}
