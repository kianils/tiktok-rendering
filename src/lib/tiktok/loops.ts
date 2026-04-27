import type { ArchivePatterns } from "./patterns";
import { SESSION_GAP_MINUTES } from "./patterns";
import type { ArchiveEvent } from "./types";

/**
 * Feedback-loop detection.
 *
 * The paper's theoretical claim rests on feedback cycles: intent is rendered
 * as a search term, attention is rendered as watch events, and the cycle
 * repeats with the search → watch conversion driving optimization. This
 * module surfaces three such loops using only timestamps and disclosed text:
 *
 *   1. Search → watch cascade. For each search event, count watch events in
 *      the same 30-minute session that follow it. This is literal evidence
 *      that a search led to more disclosed attention — the micro-loop the
 *      paper describes as "intent rendered into watch traces."
 *
 *   2. Session re-engagement cadence. Median gap between the end of one
 *      session and the start of the next. Fast re-engagement is the macro-
 *      loop: the platform trained you to come back.
 *
 *   3. Returning-interest recurrence. The share of your top search themes
 *      that reappear across multiple days — evidence that an interest
 *      persisted in your behavior long enough to be reinforced.
 *
 * No inference about TikTok's internal storage, ranking, or reinforcement
 * strategy is claimed. The loops described here are visible in *your own*
 * disclosed behavior trace.
 */

export const LOOPS_MODEL_VERSION = "loops-v1";

/** Max number of top cascades (biggest search→watch follow-ons) to surface. */
export const TOP_CASCADES = 5;

export type SearchCascade = {
  searchTerm: string;
  searchAtIso: string;
  followUpWatchCount: number;
};

export type SearchToWatchCascade = {
  searchesAnalyzed: number;
  totalFollowUpWatches: number;
  meanFollowUpWatchesPerSearch: number;
  medianFollowUpWatchesPerSearch: number;
  topCascades: SearchCascade[];
  plainLanguage: string;
};

export type ReEngagementCadence = {
  sessionCount: number;
  medianGapHours: number;
  meanGapHours: number;
  /** Number of gaps below this threshold (a "fast re-engagement"). */
  fastReturnThresholdHours: number;
  fastReturnCount: number;
  plainLanguage: string;
};

export type ReturningInterests = {
  uniqueTermsSearched: number;
  termsSearchedOnMultipleDays: number;
  returningInterestRate: number; // 0..1
  topReturningTerms: { term: string; distinctDays: number; count: number }[];
  plainLanguage: string;
};

export type ArchiveLoops = {
  modelVersion: typeof LOOPS_MODEL_VERSION;
  searchToWatchCascade: SearchToWatchCascade;
  reEngagementCadence: ReEngagementCadence;
  returningInterests: ReturningInterests;
  evidenceBasis: string;
  claimBoundary: string;
};

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Detect search and watch rows across BOTH export formats, TXT and JSON,
 * and across locales where possible.
 *
 * TXT format: events have `sourceFile` like "TikTok/Your Activity/Searches.txt",
 *   "Watch History.txt".
 * JSON format: events have `sourceFile` like "user_data_tiktok.json" and a
 *   structured `jsonPath` like "$.Activity.Search History.SearchList[0]" or
 *   "$.Activity.Video Browsing History.VideoList[i]".
 *
 * We therefore inspect both fields and look for multiple keywords (English
 * and a couple of common localisations) before concluding an event is not
 * a search or a watch. The matcher is intentionally broad; false positives
 * are tolerable here because `extractSearchTerm` has its own guard that
 * returns null for rows it cannot actually pull a query out of.
 */
function matchesAny(ev: ArchiveEvent, keywords: string[]): boolean {
  const haystack = `${ev.sourceFile} ${ev.jsonPath ?? ""} ${ev.label}`.toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

function isSearchEvent(ev: ArchiveEvent): boolean {
  return matchesAny(ev, [
    "searches.txt",
    "search history",
    "search_history",
    "searchlist",
    "search term",
    "searchterm",
    "recherche", // fr
    "búsqueda", // es
    "suche", // de
  ]);
}

function isWatchEvent(ev: ArchiveEvent): boolean {
  return matchesAny(ev, [
    "watch history",
    "watch_history",
    "video browsing history",
    "video_browsing_history",
    "videolist",
    "videobrowsing",
    "visionnage", // fr
    "historial de reproducción", // es
    "wiedergabeverlauf", // de
  ]);
}

/**
 * Pull the user's actual search string out of an event, regardless of
 * whether the parser delivered it as a TXT-block label (`"Search Term: X
 * Date: Y"`) or as a JSON-record label (`"SearchTerm: X · Date: Y"`)
 * or as a raw JSON preview.
 *
 * Order of attempts:
 *   1. JSON.parse the rawPreview and look for a known key. Handles JSON
 *      exports where labelFromRecord collapsed the object to key:value.
 *   2. Regex against label/rawPreview for the TXT format ("Search Term: X").
 *   3. Regex against label/rawPreview for the JSON label format ("SearchTerm: X").
 *
 * Returns null only if the row is not a search event at all, or if none
 * of the attempts produced a non-empty string.
 */
const SEARCH_TERM_KEYS = [
  "SearchTerm",
  "searchTerm",
  "Search Term",
  "search_term",
  "searchterm",
  "SearchString",
  "search_string",
  "query",
  "Query",
];

function extractSearchTerm(ev: ArchiveEvent): string | null {
  if (!isSearchEvent(ev)) return null;

  // 1. Try parsing rawPreview as JSON and pulling a known key.
  const raw = ev.rawPreview || "";
  if (raw.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const key of SEARCH_TERM_KEYS) {
        const val = obj[key];
        if (typeof val === "string" && val.trim()) return val.trim();
      }
    } catch {
      // fall through to regex attempts
    }
  }

  // 2. Regex on TXT-style block: "Search Term: X\nDate: Y" or with spaces.
  const text = `${ev.label} ${ev.rawPreview ?? ""}`;
  const spaced = text.match(/Search Term:\s*(.+?)(?:\s+Date:|$)/i);
  if (spaced && spaced[1]?.trim()) return spaced[1].trim();

  // 3. Regex on JSON-label style: "SearchTerm: X · Date: Y" (from
  //    labelFromRecord which uses " · " as the delimiter).
  const joined = text.match(/SearchTerm:\s*([^·\n]+)/i);
  if (joined && joined[1]?.trim()) return joined[1].trim();

  // 4. Also: "query: X"
  const queryForm = text.match(/query:\s*([^·\n]+)/i);
  if (queryForm && queryForm[1]?.trim()) return queryForm[1].trim();

  return null;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "").trim();
}

export function computeLoops(events: ArchiveEvent[], patterns: ArchivePatterns): ArchiveLoops {
  const dated = events
    .filter((e): e is ArchiveEvent & { at: string } => Boolean(e.at))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const GAP_MS = SESSION_GAP_MINUTES * 60 * 1000;

  // ---- Search → Watch cascade -----------------------------------------------
  // For each search event, count watches in the same session that occur after it.
  const cascades: SearchCascade[] = [];
  for (let i = 0; i < dated.length; i += 1) {
    const ev = dated[i];
    if (!isSearchEvent(ev)) continue;
    const term = extractSearchTerm(ev);
    if (!term) continue;
    const searchMs = Date.parse(ev.at);
    let followUps = 0;
    let lastMs = searchMs;
    for (let j = i + 1; j < dated.length; j += 1) {
      const next = dated[j];
      const nextMs = Date.parse(next.at);
      if (nextMs - lastMs > GAP_MS) break; // session boundary
      if (isWatchEvent(next)) followUps += 1;
      lastMs = nextMs;
    }
    cascades.push({ searchTerm: term, searchAtIso: ev.at, followUpWatchCount: followUps });
  }
  const searchesAnalyzed = cascades.length;
  const totalFollowUpWatches = cascades.reduce((s, c) => s + c.followUpWatchCount, 0);
  const meanFollowUpWatchesPerSearch =
    searchesAnalyzed > 0 ? Number((totalFollowUpWatches / searchesAnalyzed).toFixed(2)) : 0;
  const medianFollowUpWatchesPerSearch = Number(
    medianOf(cascades.map((c) => c.followUpWatchCount)).toFixed(2),
  );
  const topCascades = [...cascades]
    .sort((a, b) => b.followUpWatchCount - a.followUpWatchCount)
    .slice(0, TOP_CASCADES);

  const cascadePlain =
    searchesAnalyzed === 0
      ? `No searches found in this archive; the search→watch cascade cannot be measured.`
      : `On average, each search you made was followed by ${meanFollowUpWatchesPerSearch} more watches in the same session. ` +
        `Your biggest cascade was a search for "${topCascades[0]?.searchTerm ?? ""}" that was followed by ${topCascades[0]?.followUpWatchCount ?? 0} watches before you stopped scrolling. ` +
        `That is the loop: intent you typed becomes attention TikTok received.`;

  // ---- Session re-engagement cadence ----------------------------------------
  // Rebuild session start/end times, then compute gaps between adjacent sessions.
  const sessionStarts: number[] = [];
  const sessionEnds: number[] = [];
  let sStart: number | null = null;
  let sLast: number | null = null;
  for (const ev of dated) {
    const ms = Date.parse(ev.at);
    if (sStart === null || sLast === null) {
      sStart = ms;
    } else if (ms - sLast > GAP_MS) {
      sessionStarts.push(sStart);
      sessionEnds.push(sLast);
      sStart = ms;
    }
    sLast = ms;
  }
  if (sStart !== null && sLast !== null) {
    sessionStarts.push(sStart);
    sessionEnds.push(sLast);
  }
  const gapsHours: number[] = [];
  for (let i = 1; i < sessionStarts.length; i += 1) {
    gapsHours.push((sessionStarts[i] - sessionEnds[i - 1]) / 3600000);
  }
  const medianGapHours = Number(medianOf(gapsHours).toFixed(2));
  const meanGapHours =
    gapsHours.length > 0
      ? Number((gapsHours.reduce((s, v) => s + v, 0) / gapsHours.length).toFixed(2))
      : 0;
  const FAST_RETURN_HOURS = 1;
  const fastReturnCount = gapsHours.filter((g) => g < FAST_RETURN_HOURS).length;
  const fastReturnPct =
    gapsHours.length > 0 ? Math.round((fastReturnCount / gapsHours.length) * 100) : 0;

  const cadencePlain =
    gapsHours.length === 0
      ? `Fewer than two sessions detected; re-engagement cadence cannot be measured.`
      : `You re-opened TikTok every ${medianGapHours}h on average between sessions. ` +
        `${fastReturnCount.toLocaleString()} of your ${gapsHours.length.toLocaleString()} returns (${fastReturnPct}%) came back within an hour of the previous session — the fast re-engagement pattern that compulsive use looks like in a log.`;

  // ---- Returning interests --------------------------------------------------
  // For each search term (normalized), count distinct days it was searched.
  const termToDays = new Map<string, { term: string; days: Set<string>; count: number }>();
  for (const ev of dated) {
    const term = extractSearchTerm(ev);
    if (!term) continue;
    const key = normKey(term);
    if (!key) continue;
    const day = ev.at.slice(0, 10);
    const prev = termToDays.get(key);
    if (prev) {
      prev.days.add(day);
      prev.count += 1;
    } else {
      termToDays.set(key, { term, days: new Set([day]), count: 1 });
    }
  }
  const uniqueTermsSearched = termToDays.size;
  const termsMultiDay = Array.from(termToDays.values()).filter((v) => v.days.size >= 2);
  const termsSearchedOnMultipleDays = termsMultiDay.length;
  const returningInterestRate =
    uniqueTermsSearched > 0
      ? Number((termsSearchedOnMultipleDays / uniqueTermsSearched).toFixed(3))
      : 0;
  const topReturningTerms = termsMultiDay
    .sort((a, b) => b.days.size - a.days.size || b.count - a.count)
    .slice(0, 5)
    .map((v) => ({ term: v.term, distinctDays: v.days.size, count: v.count }));

  const returningPlain =
    uniqueTermsSearched === 0
      ? `No search terms in the archive, so interest return cannot be measured.`
      : termsSearchedOnMultipleDays === 0
        ? `You searched ${uniqueTermsSearched} unique terms, but none recurred on a different day. No durable-interest loop is visible.`
        : `${termsSearchedOnMultipleDays} of your ${uniqueTermsSearched} unique search terms (${Math.round(returningInterestRate * 100)}%) came back on a different day. ` +
          `"${topReturningTerms[0].term}" recurred on ${topReturningTerms[0].distinctDays} distinct days. That is a durable interest — the kind a recommender can reinforce.`;

  const evidenceBasis =
    `Search→watch cascade: ${searchesAnalyzed} searches analyzed, ${totalFollowUpWatches} total follow-up ` +
    `watches (mean ${meanFollowUpWatchesPerSearch}). ` +
    `Re-engagement: ${gapsHours.length} inter-session gaps, median ${medianGapHours}h, ` +
    `${fastReturnCount} fast returns (<${FAST_RETURN_HOURS}h). ` +
    `Returning interests: ${termsSearchedOnMultipleDays}/${uniqueTermsSearched} unique terms recurred on multiple days. ` +
    // Referencing patterns here so it doesn't appear unused and to keep the signature explicit.
    `Cross-reference: ${patterns.recurringSearchThemes.length} themes also appear in the patterns readout.`;

  const claimBoundary =
    "Describes loops visible in your disclosed behavior trace only. Does not claim that TikTok " +
    "specifically used any one row to reinforce any one interest, and does not infer emotional state.";

  return {
    modelVersion: LOOPS_MODEL_VERSION,
    searchToWatchCascade: {
      searchesAnalyzed,
      totalFollowUpWatches,
      meanFollowUpWatchesPerSearch,
      medianFollowUpWatchesPerSearch,
      topCascades,
      plainLanguage: cascadePlain,
    },
    reEngagementCadence: {
      sessionCount: sessionStarts.length,
      medianGapHours,
      meanGapHours,
      fastReturnThresholdHours: FAST_RETURN_HOURS,
      fastReturnCount,
      plainLanguage: cadencePlain,
    },
    returningInterests: {
      uniqueTermsSearched,
      termsSearchedOnMultipleDays,
      returningInterestRate,
      topReturningTerms,
      plainLanguage: returningPlain,
    },
    evidenceBasis,
    claimBoundary,
  };
}
