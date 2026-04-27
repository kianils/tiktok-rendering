"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DENSITY_THRESHOLDS = void 0;
exports.analyzeTemporalDensity = analyzeTemporalDensity;
exports.densityLabel = densityLabel;
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
exports.DENSITY_THRESHOLDS = {
    /** Trailing-window count at which a row is classified `high`. */
    high: 30,
    /** Trailing-window count at which a row is classified `elevated` (but below `high`). */
    elevated: 12,
    /** Default trailing-window length in minutes used by the UI and report. */
    windowMinutesDefault: 10,
};
function validTime(iso) {
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
}
/**
 * Measures how “thick” the behavioral trace is in short calendar time—dense streams are
 * high-leverage surplus substrate because models can update quickly from rapid micro-signals.
 */
function analyzeTemporalDensity(events, windowMinutes = exports.DENSITY_THRESHOLDS.windowMinutesDefault) {
    const WINDOW_MS = windowMinutes * 60 * 1000;
    const tierByEventId = {};
    const countByEventId = {};
    for (const e of events) {
        if (!e.at || validTime(e.at) === null) {
            tierByEventId[e.id] = "unknown";
            countByEventId[e.id] = 0;
        }
    }
    const dated = events
        .filter((e) => e.at && validTime(e.at) !== null)
        .map((e) => ({ id: e.id, t: validTime(e.at) }))
        .sort((a, b) => a.t - b.t);
    let peak = null;
    let left = 0;
    for (let i = 0; i < dated.length; i++) {
        const t = dated[i].t;
        while (left <= i && dated[left].t < t - WINDOW_MS)
            left += 1;
        const count = i - left + 1;
        countByEventId[dated[i].id] = count;
        if (!peak || count > peak.count) {
            peak = {
                count,
                startIso: new Date(dated[left].t).toISOString(),
                endIso: new Date(t).toISOString(),
            };
        }
        if (count >= exports.DENSITY_THRESHOLDS.high)
            tierByEventId[dated[i].id] = "high";
        else if (count >= exports.DENSITY_THRESHOLDS.elevated)
            tierByEventId[dated[i].id] = "elevated";
        else
            tierByEventId[dated[i].id] = "normal";
    }
    const tierCounts = {
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
        peakTrailingWindow: peak,
        datedEventCount: dated.length,
        tierCounts,
    };
}
function densityLabel(tier) {
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
