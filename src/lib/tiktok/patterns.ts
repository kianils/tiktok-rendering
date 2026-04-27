import type { ArchiveEvent } from "./types";

/**
 * Consumer-facing pattern extraction.
 *
 * Motivation. Raw density and surplus numbers are correct but opaque. This
 * module surfaces patterns in plain, personal language: when you scroll, how
 * long your sessions are, what you keep searching for, which days were
 * heaviest. Every pattern is computed deterministically from disclosed
 * timestamps and text content; none of it claims to describe TikTok's
 * internal model.
 */

export const PATTERNS_MODEL_VERSION = "patterns-v1";

/** Session boundary in minutes; consistent with extractionFlow.ts. */
export const SESSION_GAP_MINUTES = 30;

/** Session length thresholds (minutes) for the three-bucket profile. */
/**
 * Session-length buckets. A 30-minute session is a normal TikTok scroll,
 * not a binge, for people who actually use the app. The binge cutoff
 * therefore starts at an hour so the category reads as "long, sustained
 * session" rather than "noticed the app for half an hour."
 */
export const SESSION_BUCKETS = {
  quickCheckMaxMinutes: 5,
  typicalScrollMaxMinutes: 60,
} as const;

/**
 * Binge-day detection: a day is flagged as a binge IFF its daily
 * event count is in the top `BINGE_DAY_QUANTILE` of the user's own
 * daily-count distribution AND is at least `BINGE_DAY_ABSOLUTE_FLOOR`
 * times the median (so days in a very light archive are not labelled
 * "binge" on purely relative grounds).
 *
 * Why quantile, not a fixed multiple of the median. A pure 3× median
 * fires for most active days in heavy-use archives — an accuracy
 * failure: it reports "N binge days" where N is a large fraction of
 * all days, which the reader correctly reads as noise. Switching to a
 * top quantile forces the flagged set to remain a small, meaningful
 * minority regardless of overall use intensity.
 */
export const BINGE_DAY_QUANTILE = 0.9; // top 10% of the user's own days
export const BINGE_DAY_ABSOLUTE_FLOOR = 2; // at least 2× the median
export const BINGE_DAY_MULTIPLIER = 3; // kept for report back-compat

/** Number of top recurring search themes to surface. */
export const TOP_SEARCH_THEMES = 10;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "am" : "pm";
  const nextH = (hour + 1) % 24;
  const nh12 = nextH % 12 === 0 ? 12 : nextH % 12;
  const nampm = nextH < 12 ? "am" : "pm";
  return `${h12}${ampm}–${nh12}${nampm}`;
}

export type HourBucket = { hour: number; count: number; label: string };
export type DayBucket = { dayIndex: number; name: string; count: number };

export type SessionProfile = {
  quickCheckCount: number;
  typicalScrollCount: number;
  bingeCount: number;
  /** Share of total active minutes spent in each bucket (0-1). */
  quickCheckTimeShare: number;
  typicalScrollTimeShare: number;
  bingeTimeShare: number;
  totalActiveMinutes: number;
};

export type SearchTheme = { term: string; count: number };

export type BingeDay = { day: string; count: number };

export type ArchivePatterns = {
  modelVersion: typeof PATTERNS_MODEL_VERSION;
  hourOfDay: HourBucket[];
  dayOfWeek: DayBucket[];
  peakHour: HourBucket | null;
  peakDayOfWeek: DayBucket | null;
  sessionProfile: SessionProfile;
  recurringSearchThemes: SearchTheme[];
  searchesTotal: number;
  bingeDayCount: number;
  bingeDays: BingeDay[];
  medianDailyEvents: number;
  plainLanguage: {
    rhythm: string;
    sessions: string;
    searches: string;
    bingeDays: string;
  };
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
 * Pull a search query out of an event, across BOTH export formats.
 *
 * TXT: sourceFile "Searches.txt", content "Date: ...\nSearch Term: ...".
 * JSON: sourceFile "user_data_tiktok.json", jsonPath contains
 *       "Search History" or "SearchList", rawPreview is a JSON record
 *       whose key is one of a handful of variants TikTok has shipped.
 *
 * Returns null only if the row is plausibly not a search event, or if
 * no extraction strategy finds a non-empty string. Kept in lockstep with
 * the near-identical helper in `loops.ts`; any change to the detection
 * rules should be applied to both.
 */
const SEARCH_PATH_KEYWORDS = [
  "searches.txt",
  "search history",
  "search_history",
  "searchlist",
  "search term",
  "searchterm",
  "recherche",
  "búsqueda",
  "suche",
];

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
  const haystack = `${ev.sourceFile} ${ev.jsonPath ?? ""} ${ev.label}`.toLowerCase();
  const isSearch = SEARCH_PATH_KEYWORDS.some((k) => haystack.includes(k));
  if (!isSearch) return null;

  // Strategy 1. Parse rawPreview as JSON, look up known keys.
  const raw = ev.rawPreview || "";
  if (raw.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const key of SEARCH_TERM_KEYS) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    } catch {
      // fall through
    }
  }

  // Strategy 2. TXT block form: "Search Term: X\nDate: Y".
  const text = `${ev.label} ${ev.rawPreview ?? ""}`;
  const spaced = text.match(/Search Term:\s*(.+?)(?:\s+Date:|$)/i);
  if (spaced && spaced[1]?.trim()) return spaced[1].trim();

  // Strategy 3. JSON-label form: "SearchTerm: X · Date: Y".
  const joined = text.match(/SearchTerm:\s*([^·\n]+)/i);
  if (joined && joined[1]?.trim()) return joined[1].trim();

  // Strategy 4. Generic query form.
  const queryForm = text.match(/query:\s*([^·\n]+)/i);
  if (queryForm && queryForm[1]?.trim()) return queryForm[1].trim();

  return null;
}

/** Lowercase + strip punctuation; used to dedupe search terms case-/space-insensitively. */
function normalizeSearchKey(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "").trim();
}

export function computePatterns(events: ArchiveEvent[]): ArchivePatterns {
  const dated = events
    .filter((e): e is ArchiveEvent & { at: string } => Boolean(e.at))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  // Hour-of-day + day-of-week — in the runner's LOCAL timezone (this module runs
  // in the browser, so this is the user's local time; in the Node test harness
  // it is the machine's local time). Intentional: the pedagogical value is
  // "when in your day does this happen," not "when in UTC."
  const hourCounts = new Array(24).fill(0) as number[];
  const dayCounts = new Array(7).fill(0) as number[];
  for (const ev of dated) {
    const d = new Date(ev.at);
    hourCounts[d.getHours()] += 1;
    dayCounts[d.getDay()] += 1;
  }
  const hourOfDay: HourBucket[] = hourCounts.map((count, hour) => ({
    hour,
    count,
    label: hourLabel(hour),
  }));
  const dayOfWeek: DayBucket[] = dayCounts.map((count, dayIndex) => ({
    dayIndex,
    name: DAY_NAMES[dayIndex],
    count,
  }));
  const peakHour = hourOfDay.reduce<HourBucket | null>(
    (best, h) => (best === null || h.count > best.count ? h : best),
    null,
  );
  const peakDayOfWeek = dayOfWeek.reduce<DayBucket | null>(
    (best, d) => (best === null || d.count > best.count ? d : best),
    null,
  );

  // Session profile: group events into sessions and bucket by length.
  const GAP_MS = SESSION_GAP_MINUTES * 60 * 1000;
  const sessionLengthsMin: number[] = [];
  let sStart: number | null = null;
  let sLast: number | null = null;
  for (const ev of dated) {
    const ms = Date.parse(ev.at);
    if (sStart === null || sLast === null) {
      sStart = ms;
    } else if (ms - sLast > GAP_MS) {
      sessionLengthsMin.push((sLast - sStart) / 60000);
      sStart = ms;
    }
    sLast = ms;
  }
  if (sStart !== null && sLast !== null) sessionLengthsMin.push((sLast - sStart) / 60000);

  let quickCheckCount = 0;
  let typicalScrollCount = 0;
  let bingeCount = 0;
  let quickCheckMin = 0;
  let typicalScrollMin = 0;
  let bingeMin = 0;
  for (const m of sessionLengthsMin) {
    if (m < SESSION_BUCKETS.quickCheckMaxMinutes) {
      quickCheckCount += 1;
      quickCheckMin += m;
    } else if (m < SESSION_BUCKETS.typicalScrollMaxMinutes) {
      typicalScrollCount += 1;
      typicalScrollMin += m;
    } else {
      bingeCount += 1;
      bingeMin += m;
    }
  }
  const totalActiveMinutes = Number((quickCheckMin + typicalScrollMin + bingeMin).toFixed(1));
  const tm = totalActiveMinutes || 1;
  const sessionProfile: SessionProfile = {
    quickCheckCount,
    typicalScrollCount,
    bingeCount,
    quickCheckTimeShare: Number((quickCheckMin / tm).toFixed(3)),
    typicalScrollTimeShare: Number((typicalScrollMin / tm).toFixed(3)),
    bingeTimeShare: Number((bingeMin / tm).toFixed(3)),
    totalActiveMinutes,
  };

  // Recurring search themes.
  const searchMap = new Map<string, { term: string; count: number }>();
  for (const ev of dated) {
    const term = extractSearchTerm(ev);
    if (!term) continue;
    const key = normalizeSearchKey(term);
    if (!key) continue;
    const prev = searchMap.get(key);
    if (prev) prev.count += 1;
    else searchMap.set(key, { term, count: 1 });
  }
  const recurringSearchThemes: SearchTheme[] = Array.from(searchMap.values())
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .filter((s) => s.count >= 2)
    .slice(0, TOP_SEARCH_THEMES);
  const searchesTotal = Array.from(searchMap.values()).reduce((s, v) => s + v.count, 0);

  // Binge days: top-decile days of the user's own distribution, with
  // an absolute floor at 2× median so small archives don't spuriously
  // flag low-activity days. Previous logic used 3× median which fired
  // for most active days in heavy-use archives and produced noise.
  const dailyCounts = new Map<string, number>();
  for (const ev of dated) {
    const day = ev.at.slice(0, 10);
    dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
  }
  const dailyValues = Array.from(dailyCounts.values());
  const medianDailyEvents = Number(medianOf(dailyValues).toFixed(0));

  // Linear-interpolated quantile over sorted daily counts.
  const sortedDaily = [...dailyValues].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    if (sortedDaily.length === 0) return 0;
    if (q <= 0) return sortedDaily[0]!;
    if (q >= 1) return sortedDaily[sortedDaily.length - 1]!;
    const idx = q * (sortedDaily.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedDaily[lo]!;
    return sortedDaily[lo]! + (sortedDaily[hi]! - sortedDaily[lo]!) * (idx - lo);
  };
  const quantileCut = Math.ceil(quantile(BINGE_DAY_QUANTILE));
  const floorCut = medianDailyEvents * BINGE_DAY_ABSOLUTE_FLOOR;
  const threshold = Math.max(quantileCut, floorCut);
  const bingeDays: BingeDay[] = Array.from(dailyCounts.entries())
    .filter(([, c]) => c >= threshold)
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => b.count - a.count);

  // Plain-language summaries. Days are named by their 3-letter short name in
  // the runner's locale; we pluralize by suffixing "s" for readability.
  const dayLongNames: Record<string, string> = {
    Sun: "Sundays",
    Mon: "Mondays",
    Tue: "Tuesdays",
    Wed: "Wednesdays",
    Thu: "Thursdays",
    Fri: "Fridays",
    Sat: "Saturdays",
  };
  const peakDayName = peakDayOfWeek ? dayLongNames[peakDayOfWeek.name] ?? peakDayOfWeek.name : "a weekday";
  const rhythm = peakHour
    ? `Most of your TikTok time falls between ${peakHour.label} (your local time). You were most active on ${peakDayName}.`
    : `Activity timestamps are too sparse to detect a rhythm.`;

  const bingePct = Math.round(sessionProfile.bingeTimeShare * 100);
  const bingeSessPct =
    sessionLengthsMin.length > 0
      ? Math.round((sessionProfile.bingeCount / sessionLengthsMin.length) * 100)
      : 0;
  const sessions =
    sessionLengthsMin.length === 0
      ? `No sessions detected (fewer than two dated events).`
      : `Most of your sessions (${Math.round(
          (sessionProfile.quickCheckCount / sessionLengthsMin.length) * 100,
        )}%) are quick checks under ${SESSION_BUCKETS.quickCheckMaxMinutes} minutes. But binges over ${SESSION_BUCKETS.typicalScrollMaxMinutes} minutes, only ${bingeSessPct}% of your sessions, accounted for about ${bingePct}% of your total TikTok time.`;

  const searches =
    recurringSearchThemes.length === 0
      ? `You made ${searchesTotal} search${searchesTotal === 1 ? "" : "es"}${
          searchesTotal > 0 ? "; no term came up twice" : ""
        }.`
      : `You searched "${recurringSearchThemes[0].term}" ${recurringSearchThemes[0].count} times — your most repeated query${
          recurringSearchThemes.length > 1
            ? `, followed by "${recurringSearchThemes[1].term}" (${recurringSearchThemes[1].count})`
            : ""
        }. TikTok received each query as legible intent.`;

  const totalDays = dailyCounts.size;
  const bingeDayShare =
    totalDays > 0 ? Math.round((bingeDays.length / totalDays) * 100) : 0;
  const bingeDaysSummary =
    bingeDays.length === 0
      ? `No day in your archive crossed the binge threshold (top ${Math.round((1 - BINGE_DAY_QUANTILE) * 100)}% of your own daily distribution, ≥ ${threshold} signals).`
      : `${bingeDays.length} of your ${totalDays} active days (${bingeDayShare}%) crossed the binge threshold of ${threshold}+ signals — the top ${Math.round((1 - BINGE_DAY_QUANTILE) * 100)}% of your own daily distribution (your median day carries ${medianDailyEvents} signals). Your heaviest was ${bingeDays[0]?.day} with ${bingeDays[0]?.count.toLocaleString()} signals — roughly ${(bingeDays[0]!.count / Math.max(1, medianDailyEvents)).toFixed(1)}× a median day.`;

  const evidenceBasis =
    `${dated.length} dated events; peak hour ${peakHour?.label ?? "n/a"}; ${sessionLengthsMin.length} ` +
    `sessions (30-min gap); ${recurringSearchThemes.length} recurring search themes out of ` +
    `${searchMap.size} unique queries; ${bingeDays.length} binge days at or above ${threshold} events ` +
    `(top ${Math.round((1 - BINGE_DAY_QUANTILE) * 100)}% of your daily distribution; median day = ${medianDailyEvents}).`;

  const claimBoundary =
    "All patterns are computed from disclosed timestamps and text content in your export. " +
    "They describe your observable rhythm, not TikTok's internal model of you, and do not infer emotional state.";

  return {
    modelVersion: PATTERNS_MODEL_VERSION,
    hourOfDay,
    dayOfWeek,
    peakHour,
    peakDayOfWeek,
    sessionProfile,
    recurringSearchThemes,
    searchesTotal,
    bingeDayCount: bingeDays.length,
    bingeDays: bingeDays.slice(0, 10),
    medianDailyEvents,
    plainLanguage: { rhythm, sessions, searches, bingeDays: bingeDaysSummary },
    evidenceBasis,
    claimBoundary,
  };
}
