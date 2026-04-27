"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOP_SEARCH_THEMES = exports.BINGE_DAY_MULTIPLIER = exports.SESSION_BUCKETS = exports.SESSION_GAP_MINUTES = exports.PATTERNS_MODEL_VERSION = void 0;
exports.computePatterns = computePatterns;
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
exports.PATTERNS_MODEL_VERSION = "patterns-v1";
/** Session boundary in minutes; consistent with extractionFlow.ts. */
exports.SESSION_GAP_MINUTES = 30;
/** Session length thresholds (minutes) for the three-bucket profile. */
exports.SESSION_BUCKETS = {
    quickCheckMaxMinutes: 5,
    typicalScrollMaxMinutes: 30,
};
/** Multiple of the median daily event count that defines a "binge day". */
exports.BINGE_DAY_MULTIPLIER = 3;
/** Number of top recurring search themes to surface. */
exports.TOP_SEARCH_THEMES = 10;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function hourLabel(hour) {
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "am" : "pm";
    const nextH = (hour + 1) % 24;
    const nh12 = nextH % 12 === 0 ? 12 : nextH % 12;
    const nampm = nextH < 12 ? "am" : "pm";
    return `${h12}${ampm}–${nh12}${nampm}`;
}
function medianOf(values) {
    if (!values.length)
        return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function extractSearchTerm(ev) {
    if (!ev.sourceFile.toLowerCase().includes("searches.txt"))
        return null;
    const text = ev.label || ev.rawPreview || "";
    const m = text.match(/Search Term:\s*(.+?)(?:\s+Date:|$)/i);
    if (!m)
        return null;
    return m[1].trim();
}
/** Lowercase + strip punctuation; used to dedupe search terms case-/space-insensitively. */
function normalizeSearchKey(term) {
    return term.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "").trim();
}
function computePatterns(events) {
    const dated = events
        .filter((e) => Boolean(e.at))
        .sort((a, b) => (a.at < b.at ? -1 : 1));
    // Hour-of-day + day-of-week — in the runner's LOCAL timezone (this module runs
    // in the browser, so this is the user's local time; in the Node test harness
    // it is the machine's local time). Intentional: the pedagogical value is
    // "when in your day does this happen," not "when in UTC."
    const hourCounts = new Array(24).fill(0);
    const dayCounts = new Array(7).fill(0);
    for (const ev of dated) {
        const d = new Date(ev.at);
        hourCounts[d.getHours()] += 1;
        dayCounts[d.getDay()] += 1;
    }
    const hourOfDay = hourCounts.map((count, hour) => ({
        hour,
        count,
        label: hourLabel(hour),
    }));
    const dayOfWeek = dayCounts.map((count, dayIndex) => ({
        dayIndex,
        name: DAY_NAMES[dayIndex],
        count,
    }));
    const peakHour = hourOfDay.reduce((best, h) => (best === null || h.count > best.count ? h : best), null);
    const peakDayOfWeek = dayOfWeek.reduce((best, d) => (best === null || d.count > best.count ? d : best), null);
    // Session profile: group events into sessions and bucket by length.
    const GAP_MS = exports.SESSION_GAP_MINUTES * 60 * 1000;
    const sessionLengthsMin = [];
    let sStart = null;
    let sLast = null;
    for (const ev of dated) {
        const ms = Date.parse(ev.at);
        if (sStart === null || sLast === null) {
            sStart = ms;
        }
        else if (ms - sLast > GAP_MS) {
            sessionLengthsMin.push((sLast - sStart) / 60000);
            sStart = ms;
        }
        sLast = ms;
    }
    if (sStart !== null && sLast !== null)
        sessionLengthsMin.push((sLast - sStart) / 60000);
    let quickCheckCount = 0;
    let typicalScrollCount = 0;
    let bingeCount = 0;
    let quickCheckMin = 0;
    let typicalScrollMin = 0;
    let bingeMin = 0;
    for (const m of sessionLengthsMin) {
        if (m < exports.SESSION_BUCKETS.quickCheckMaxMinutes) {
            quickCheckCount += 1;
            quickCheckMin += m;
        }
        else if (m < exports.SESSION_BUCKETS.typicalScrollMaxMinutes) {
            typicalScrollCount += 1;
            typicalScrollMin += m;
        }
        else {
            bingeCount += 1;
            bingeMin += m;
        }
    }
    const totalActiveMinutes = Number((quickCheckMin + typicalScrollMin + bingeMin).toFixed(1));
    const tm = totalActiveMinutes || 1;
    const sessionProfile = {
        quickCheckCount,
        typicalScrollCount,
        bingeCount,
        quickCheckTimeShare: Number((quickCheckMin / tm).toFixed(3)),
        typicalScrollTimeShare: Number((typicalScrollMin / tm).toFixed(3)),
        bingeTimeShare: Number((bingeMin / tm).toFixed(3)),
        totalActiveMinutes,
    };
    // Recurring search themes.
    const searchMap = new Map();
    for (const ev of dated) {
        const term = extractSearchTerm(ev);
        if (!term)
            continue;
        const key = normalizeSearchKey(term);
        if (!key)
            continue;
        const prev = searchMap.get(key);
        if (prev)
            prev.count += 1;
        else
            searchMap.set(key, { term, count: 1 });
    }
    const recurringSearchThemes = Array.from(searchMap.values())
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
        .filter((s) => s.count >= 2)
        .slice(0, exports.TOP_SEARCH_THEMES);
    const searchesTotal = Array.from(searchMap.values()).reduce((s, v) => s + v.count, 0);
    // Binge days: days with event count above threshold × median daily count.
    const dailyCounts = new Map();
    for (const ev of dated) {
        const day = ev.at.slice(0, 10);
        dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
    }
    const dailyValues = Array.from(dailyCounts.values());
    const medianDailyEvents = Number(medianOf(dailyValues).toFixed(0));
    const threshold = medianDailyEvents * exports.BINGE_DAY_MULTIPLIER;
    const bingeDays = Array.from(dailyCounts.entries())
        .filter(([, c]) => c > threshold)
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => b.count - a.count);
    // Plain-language summaries. Days are named by their 3-letter short name in
    // the runner's locale; we pluralize by suffixing "s" for readability.
    const dayLongNames = {
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
    const bingeSessPct = sessionLengthsMin.length > 0
        ? Math.round((sessionProfile.bingeCount / sessionLengthsMin.length) * 100)
        : 0;
    const sessions = sessionLengthsMin.length === 0
        ? `No sessions detected (fewer than two dated events).`
        : `Most of your sessions (${Math.round((sessionProfile.quickCheckCount / sessionLengthsMin.length) * 100)}%) are quick checks under ${exports.SESSION_BUCKETS.quickCheckMaxMinutes} minutes. But binges over ${exports.SESSION_BUCKETS.typicalScrollMaxMinutes} minutes — only ${bingeSessPct}% of your sessions — accounted for about ${bingePct}% of your total TikTok time.`;
    const searches = recurringSearchThemes.length === 0
        ? `You made ${searchesTotal} search${searchesTotal === 1 ? "" : "es"}${searchesTotal > 0 ? "; no term came up twice" : ""}.`
        : `You searched "${recurringSearchThemes[0].term}" ${recurringSearchThemes[0].count} times — your most repeated query${recurringSearchThemes.length > 1
            ? `, followed by "${recurringSearchThemes[1].term}" (${recurringSearchThemes[1].count})`
            : ""}. TikTok received each query as legible intent.`;
    const bingeDaysSummary = bingeDays.length === 0
        ? `No single day stood out as an extraction binge (all days under ${exports.BINGE_DAY_MULTIPLIER}× your median ${medianDailyEvents}/day).`
        : `You had ${bingeDays.length} binge day${bingeDays.length === 1 ? "" : "s"} — days where TikTok received more than ${threshold} signals from you. Your heaviest was ${bingeDays[0].day} with ${bingeDays[0].count.toLocaleString()} signals.`;
    const evidenceBasis = `${dated.length} dated events; peak hour ${peakHour?.label ?? "n/a"}; ${sessionLengthsMin.length} ` +
        `sessions (30-min gap); ${recurringSearchThemes.length} recurring search themes out of ` +
        `${searchMap.size} unique queries; ${bingeDays.length} binge days above ${threshold} events ` +
        `(${exports.BINGE_DAY_MULTIPLIER}× median of ${medianDailyEvents}/day).`;
    const claimBoundary = "All patterns are computed from disclosed timestamps and text content in your export. " +
        "They describe your observable rhythm, not TikTok's internal model of you, and do not infer emotional state.";
    return {
        modelVersion: exports.PATTERNS_MODEL_VERSION,
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
