"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARCHIVE_VOLUME_NORMALIZER = exports.ARCHIVE_THRESHOLDS = exports.ARCHIVE_WEIGHTS = exports.ARCHIVE_SCORE_MODEL_VERSION = void 0;
exports.scoreArchive = scoreArchive;
const infer_1 = require("./infer");
/**
 * Archive-level surplus scoring.
 *
 * Motivation. Row-level surplus scoring is content-first by design: each row
 * is judged on the evidence in its own label/preview/path. That is appropriate
 * for per-row auditability, but it systematically under-reads the paper's
 * claim when applied to TikTok's official TXT exports, because those files
 * carry only one signal type per row (a Watch History line is a date + link;
 * a Searches line is a date + query). A row's standalone `signalRichness`
 * therefore stays modest even when the archive as a whole is dense and
 * surplus-friendly in exactly the sense Zuboff describes.
 *
 * This module computes an *archive-level* surplus score from coverage,
 * density, identity presence, breadth, and volume — dimensions that are
 * correctly read at the archive level, not at the row level. It is
 * complementary to the row-level verdict; it does not replace it, and it
 * does not feed back into any row's score.
 *
 * Design constraints (consistent with the row-level module):
 *
 * 1. Published weights and thresholds; snapshotted into the report's model
 *    metadata for reproducibility.
 *
 * 2. No emotion inference; no external-data join; no claim about TikTok's
 *    internal ranking coefficients. `evidenceBasis` names the measured
 *    shares and tiers; `claimBoundary` names what is not asserted.
 *
 * 3. Deterministic given the same archive and the same config snapshot.
 *
 * 4. Monotone: each component is a 0-100 score where higher means
 *    "more surplus-friendly." The composite is a fixed linear combination.
 */
exports.ARCHIVE_SCORE_MODEL_VERSION = "archive-surplus-v1";
/**
 * Weights for the components of the archive-level surplus score.
 * Sum to 1.0 so the composite is a convex combination on 0-100.
 *
 * Rationale:
 *   - densityIndex is the largest single component because the paper's claim
 *     is specifically about "rendering many gestures per minute" — the rhythm
 *     of trace generation is what distinguishes TikTok-class feeds from
 *     slower platforms.
 *   - attentionCoverage and intentCoverage carry the signal types Boeker &
 *     Urman (2022) and Zannettou et al. (CHI 2024) identify as most directly
 *     feeding ranking optimization.
 *   - identityPresence matters because identity persistence is what lets a
 *     single row become a durable model update rather than ephemeral residue.
 *   - signalBreadth and volume are smaller: they describe shape (diversity,
 *     size) rather than operationally-relevant content.
 */
exports.ARCHIVE_WEIGHTS = {
    densityIndex: 0.3,
    attentionCoverage: 0.2,
    intentCoverage: 0.15,
    identityPresence: 0.15,
    signalBreadth: 0.1,
    volume: 0.1,
};
/**
 * Verdict cutoffs on the 0-100 composite. Chosen so that an archive whose
 * components sit uniformly at "moderate" (around 40-50 each) lands in the
 * `moderate_surplus_archive` band, and `high_surplus_archive` requires at
 * least two components to be strong.
 */
exports.ARCHIVE_THRESHOLDS = {
    highSurplusMin: 60,
    moderateMin: 30,
};
/**
 * Volume component normalizer: dated event count is scaled by this and
 * capped at 100. 10,000 dated events represents the order of magnitude at
 * which an archive's volume is no longer the limiting factor for surplus
 * generation; beyond this, other components dominate.
 */
exports.ARCHIVE_VOLUME_NORMALIZER = 10000;
const SIGNAL_TYPE_UNIVERSE_SIZE = 9;
function clamp100(v) {
    return Math.max(0, Math.min(100, Math.round(v)));
}
function archiveVerdict(score) {
    if (score >= exports.ARCHIVE_THRESHOLDS.highSurplusMin)
        return "high_surplus_archive";
    if (score >= exports.ARCHIVE_THRESHOLDS.moderateMin)
        return "moderate_surplus_archive";
    return "low_surplus_archive";
}
function scoreArchive(events, density) {
    const n = events.length || 1;
    const datedN = density.datedEventCount || 1;
    // Count per-signal row presence and track distinct signal types observed.
    const perSignal = {
        explicit_feedback_actions: 0,
        watch_time_or_consumption_signals: 0,
        text_query_intent_signals: 0,
        social_graph_interaction_signals: 0,
        account_or_session_linkage_signals: 0,
        device_fingerprint_signals: 0,
        location_or_locale_signals: 0,
        topic_or_hashtag_signals: 0,
        low_structured_signal_content: 0,
    };
    const observedTypes = new Set();
    let rowsWithIdentityClass = 0;
    for (const ev of events) {
        const inf = (0, infer_1.inferRow)(ev);
        const rowHas = new Set(inf.signals);
        for (const s of rowHas) {
            perSignal[s] = (perSignal[s] ?? 0) + 1;
            observedTypes.add(s);
        }
        if (rowHas.has("account_or_session_linkage_signals") ||
            rowHas.has("device_fingerprint_signals") ||
            rowHas.has("location_or_locale_signals")) {
            rowsWithIdentityClass += 1;
        }
    }
    const highOrElevated = density.tierCounts.high + density.tierCounts.elevated;
    const densityIndex = clamp100((highOrElevated / datedN) * 100);
    const attentionCoverage = clamp100((perSignal.watch_time_or_consumption_signals / n) * 100);
    const intentCoverage = clamp100((perSignal.text_query_intent_signals / n) * 100);
    const identityPresence = clamp100((rowsWithIdentityClass / n) * 100);
    const signalBreadth = clamp100((observedTypes.size / SIGNAL_TYPE_UNIVERSE_SIZE) * 100);
    const volume = clamp100((density.datedEventCount / exports.ARCHIVE_VOLUME_NORMALIZER) * 100);
    const score = clamp100(exports.ARCHIVE_WEIGHTS.densityIndex * densityIndex +
        exports.ARCHIVE_WEIGHTS.attentionCoverage * attentionCoverage +
        exports.ARCHIVE_WEIGHTS.intentCoverage * intentCoverage +
        exports.ARCHIVE_WEIGHTS.identityPresence * identityPresence +
        exports.ARCHIVE_WEIGHTS.signalBreadth * signalBreadth +
        exports.ARCHIVE_WEIGHTS.volume * volume);
    const verdict = archiveVerdict(score);
    const components = {
        densityIndex,
        attentionCoverage,
        intentCoverage,
        identityPresence,
        signalBreadth,
        volume,
    };
    const evidenceBasis = `Composite of ${Math.round(highOrElevated)} rows in high/elevated density tier across ${datedN} dated rows ` +
        `(${densityIndex}/100), attention coverage ${attentionCoverage}%, intent coverage ${intentCoverage}%, ` +
        `identity-class presence ${identityPresence}%, ${observedTypes.size}/${SIGNAL_TYPE_UNIVERSE_SIZE} signal ` +
        `types observed, volume index ${volume}/100.`;
    const claimBoundary = "Describes how surplus-friendly the disclosed archive *looks* in aggregate. " +
        "Does not recover TikTok's internal ranking coefficients, does not infer emotional state, " +
        "and does not imply any particular row was itself used to update a model.";
    return {
        modelVersion: exports.ARCHIVE_SCORE_MODEL_VERSION,
        score,
        verdict,
        components,
        evidenceBasis,
        claimBoundary,
    };
}
