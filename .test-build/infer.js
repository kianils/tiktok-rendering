"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COUNTERFACTUAL_BORDERLINE_RADIUS = exports.CONFIDENCE_CUTOFFS = exports.SURPLUS_WEIGHTS = exports.SURPLUS_THRESHOLDS = exports.FEATURE_EXTRACTION_RULESET_VERSION = exports.INFERENCE_MODEL_VERSION = void 0;
exports.inferRow = inferRow;
exports.surplusCounts = surplusCounts;
/**
 * Content-first deterministic inference.
 *
 * Pipeline: ArchiveEvent -> feature extraction -> per-dimension scores (0-100) ->
 * weighted surplus score -> threshold-based verdict + uncertainty mapping.
 *
 * Design constraints (see README "Methodology"):
 *
 * 1. Content-first. Scoring reads the row's own text content (label, raw preview,
 *    file path, JSON path), not the event's primitive classification as a backbone.
 *    `primitive` contributes only a small tie-breaker prior — intentionally tiny so
 *    that it cannot flip a verdict on its own.
 *
 * 2. Auditable. Every score is produced by a named function with published weights
 *    and thresholds (below). The report embeds the model version + ruleset version
 *    + threshold snapshot so a given input archive produces identical row-level
 *    scores and verdicts under a given config.
 *
 * 3. Claim-bounded. Scores describe evidence observable in the disclosed row. They
 *    do not claim to recover TikTok's internal ranking coefficients, embeddings,
 *    labels, or retention policies. The `loop` field names a plausible optimization
 *    pathway consistent with the row's extracted signals — not a proven internal flow.
 *
 * 4. No emotion inference. Nothing in this module reads emotional state from traces.
 *    User self-annotations in the UI are stored separately and never fed back into
 *    scoring.
 *
 * 5. Feature extraction is regex-based over lowercased row text. That has known
 *    limits: it is English-biased, surface-form-biased, and can miss structured
 *    fields whose keys are not represented in the label/preview. We accept these
 *    limits because the alternative (ML on user data) would conflict with the
 *    content-first, deterministic, locally-runnable guarantee.
 */
// --- Versioning & thresholds (snapshotted into the report for reproducibility) ---
exports.INFERENCE_MODEL_VERSION = "content-first-v2";
exports.FEATURE_EXTRACTION_RULESET_VERSION = "regex-ruleset-v1";
/**
 * Surplus verdict cutoffs on the 0-100 `surplusScore`.
 * `likely_surplus` >= likelySurplusMin; `mixed` >= mixedMin; else `unclear`.
 */
exports.SURPLUS_THRESHOLDS = {
    likelySurplusMin: 67,
    mixedMin: 43,
};
/**
 * Weights for the composite `surplusScore`. These are deliberately published
 * (not magic numbers) so the computation is auditable. Rationale:
 *   - signalRichness dominates because a surplus judgment should track the
 *     *variety and density of observed features*, not one axis.
 *   - identityLinkage matters because linkage is what turns a single trace
 *     into a durable model update (Zuboff's rendering-into-operational-fact).
 *   - dataQuality is smaller because it measures parse completeness, not
 *     information content — a well-formed row with no signals is not surplus.
 *   - Two small "bonus" terms give additional weight to the two signal types
 *     that most directly feed ranking optimization (attention and text intent),
 *     grounded in Boeker & Urman (2022) and Zannettou et al. (CHI 2024).
 */
exports.SURPLUS_WEIGHTS = {
    signalRichness: 0.45,
    identityLinkage: 0.25,
    dataQuality: 0.2,
    watchBonus: 8,
    searchBonus: 6,
};
/** Confidence-band cutoffs applied to individual 0-100 scores and means of scores. */
exports.CONFIDENCE_CUTOFFS = {
    high: 68,
    medium: 38,
};
/**
 * Distance-to-boundary (in surplusScore units) at which we flag a row as
 * `borderline`. Small movements in thresholds within this band could flip
 * the verdict, so the UI warns the reader.
 */
exports.COUNTERFACTUAL_BORDERLINE_RADIUS = 4;
function textFor(ev) {
    return `${ev.sourceFile} ${ev.jsonPath ?? ""} ${ev.label} ${ev.rawPreview}`.toLowerCase();
}
/**
 * Extract binary + simple count features from a row's lowercased text surface.
 *
 * Regex scope is deliberately narrow and English-keyword-based. Each group names
 * a category of machine-readable signal that the literature associates with
 * ranking optimization or identity linkage; see README "Methodology" for
 * references. Known limits:
 *   - English-biased vocabulary (e.g. "search", "watch"); non-English exports
 *     will under-detect signals and therefore under-estimate surplus.
 *   - Surface-form: matches on keywords in labels/previews, not structured
 *     JSON keys that were not surfaced into the preview text.
 *   - Coarse: we do not distinguish "searched once" from "searched 50 times" —
 *     per-row granularity is appropriate for per-row scoring, and volume is
 *     captured separately by the temporal-density pass.
 */
function extractFeatures(ev) {
    const text = textFor(ev);
    const tokens = text.split(/[^a-z0-9_@#]+/).filter(Boolean);
    return {
        hasTimestamp: Boolean(ev.at),
        tokenCount: tokens.length,
        hasUrl: /https?:\/\/|www\./.test(text),
        // Explicit feedback: acts the user knowingly performs as feedback.
        hasExplicitAction: /\b(like|liked|favorite|save|saved|share|shared|follow|followed|comment|react)\b/.test(text),
        // Consumption/attention: watch-time-adjacent signals even when dwell time isn't exported.
        hasWatchSignals: /\b(watch|watched|view|viewed|duration|dwell|rewatch|paused|skip|completion|play)\b/.test(text),
        // Text-query intent: searches render goals in plain language.
        hasSearchSignals: /\b(search|query|keyword|lookup|discover)\b/.test(text),
        // Social-graph interaction: messages/mentions that knit a relational graph.
        hasSocialSignals: /\b(message|reply|comment|mention|chat|dm)\b|@[\w.]+/.test(text),
        // Account/session linkage: identity continuity across sessions.
        hasIdentitySignals: /\b(account|profile|login|signin|sign in|session|user id|userid|uid|cookie|token)\b/.test(text),
        // Location/locale: coarse geographic or language inference surface.
        hasLocationSignals: /\b(location|country|region|timezone|ip|language)\b/.test(text),
        // Device fingerprint: hardware/software identifiers that support relinkage.
        hasDeviceSignals: /\b(device|model|browser|os|platform|android|iphone|ios)\b/.test(text),
        // Topic/hashtag: creator/category/hashtag cues usable as content features.
        hasInterestSignals: /#\w+|\b(topic|tag|hashtag|category|sound|creator)\b/.test(text),
    };
}
function clamp100(v) {
    return Math.max(0, Math.min(100, Math.round(v)));
}
/**
 * Map a 0-100 score (or a mean of such scores) to a confidence band using
 * published cutoffs. The same mapping is used for overall row confidence
 * and for each uncertainty dimension, so readers only need to learn one rule.
 */
function toConfidence(score) {
    if (score >= exports.CONFIDENCE_CUTOFFS.high)
        return "high";
    if (score >= exports.CONFIDENCE_CUTOFFS.medium)
        return "medium";
    return "low";
}
function scoreFeatures(features, ev) {
    // Minimal primitive weight is intentionally tiny; content features dominate.
    // A row whose primitive is `unknown` or `account` can still be flagged as
    // likely_surplus if its content reveals rich signals — and vice versa.
    const primitivePrior = ev.primitive === "unknown" ? 0 : ev.primitive === "preference" || ev.primitive === "intent" ? 3 : 1;
    const dataQualityScore = clamp100((features.hasTimestamp ? 40 : 0) + Math.min(30, features.tokenCount / 3) + (features.hasUrl ? 10 : 0));
    const signalRichnessScore = clamp100((features.hasExplicitAction ? 18 : 0) +
        (features.hasWatchSignals ? 16 : 0) +
        (features.hasSearchSignals ? 16 : 0) +
        (features.hasSocialSignals ? 14 : 0) +
        (features.hasInterestSignals ? 12 : 0) +
        (features.hasDeviceSignals ? 10 : 0) +
        (features.hasLocationSignals ? 8 : 0) +
        primitivePrior);
    const identityLinkageScore = clamp100((features.hasIdentitySignals ? 40 : 0) +
        (features.hasDeviceSignals ? 25 : 0) +
        (features.hasLocationSignals ? 20 : 0) +
        (features.hasTimestamp ? 15 : 0));
    const surplusScore = clamp100(exports.SURPLUS_WEIGHTS.signalRichness * signalRichnessScore +
        exports.SURPLUS_WEIGHTS.identityLinkage * identityLinkageScore +
        exports.SURPLUS_WEIGHTS.dataQuality * dataQualityScore +
        (features.hasWatchSignals ? exports.SURPLUS_WEIGHTS.watchBonus : 0) +
        (features.hasSearchSignals ? exports.SURPLUS_WEIGHTS.searchBonus : 0));
    return { dataQualityScore, signalRichnessScore, identityLinkageScore, surplusScore };
}
function signalsFromFeatures(features) {
    const out = [];
    if (features.hasExplicitAction)
        out.push("explicit_feedback_actions");
    if (features.hasWatchSignals)
        out.push("watch_time_or_consumption_signals");
    if (features.hasSearchSignals)
        out.push("text_query_intent_signals");
    if (features.hasSocialSignals)
        out.push("social_graph_interaction_signals");
    if (features.hasIdentitySignals)
        out.push("account_or_session_linkage_signals");
    if (features.hasDeviceSignals)
        out.push("device_fingerprint_signals");
    if (features.hasLocationSignals)
        out.push("location_or_locale_signals");
    if (features.hasInterestSignals)
        out.push("topic_or_hashtag_signals");
    if (!out.length)
        out.push("low_structured_signal_content");
    return out;
}
function surplusVerdict(score) {
    if (score >= exports.SURPLUS_THRESHOLDS.likelySurplusMin)
        return "likely_surplus";
    if (score >= exports.SURPLUS_THRESHOLDS.mixedMin)
        return "mixed";
    return "unclear";
}
/**
 * Map metrics onto per-dimension uncertainty bands. Semantics:
 *   - dataCompleteness: how complete/parseable the row payload itself is.
 *   - signalStrength: how rich and varied the extracted behavior signals are.
 *   - linkageStrength: how strongly the row can be tied to session/identity state.
 *   - counterfactualSensitivity: `borderline` when the surplus score is within
 *     `COUNTERFACTUAL_BORDERLINE_RADIUS` of either verdict cutoff — warning the
 *     reader that small threshold changes could flip this row's verdict.
 *
 * Importantly, *none* of these bands express certainty about TikTok's internal
 * model. They describe only our confidence that the export row *looks* like the
 * kind of substrate the literature associates with ranking optimization.
 */
function uncertaintyFromMetrics(metrics) {
    const distanceToBoundary = Math.min(Math.abs(metrics.surplusScore - exports.SURPLUS_THRESHOLDS.likelySurplusMin), Math.abs(metrics.surplusScore - exports.SURPLUS_THRESHOLDS.mixedMin));
    return {
        dataCompleteness: toConfidence(metrics.dataQualityScore),
        signalStrength: toConfidence(metrics.signalRichnessScore),
        linkageStrength: toConfidence(metrics.identityLinkageScore),
        counterfactualSensitivity: distanceToBoundary <= exports.COUNTERFACTUAL_BORDERLINE_RADIUS ? "borderline" : "stable",
    };
}
function renderingFromSignals(signals) {
    return `Observed row content includes: ${signals.join(", ")}. These are machine-readable features that can be transformed into ranking vectors, retrieval features, and persistence-linked user state.`;
}
function surplusRationale(score, metrics) {
    return `Surplus score ${score}/100 computed from signal richness (${metrics.signalRichnessScore}), identity linkage (${metrics.identityLinkageScore}), and data quality (${metrics.dataQualityScore}). Higher scores indicate more reusable information beyond a single interaction moment.`;
}
function loopFromSignals(signals) {
    if (signals.includes("watch_time_or_consumption_signals")) {
        return "Optimization pathway: attention-weighted re-ranking toward similar pace/topic/format patterns observed in consumption traces.";
    }
    if (signals.includes("text_query_intent_signals")) {
        return "Optimization pathway: intent-linked retrieval expansion and candidate generation from query-like text signals.";
    }
    if (signals.includes("social_graph_interaction_signals")) {
        return "Optimization pathway: graph-proximity amplification for creators/topics tied to observed social interaction paths.";
    }
    if (signals.includes("account_or_session_linkage_signals")) {
        return "Optimization pathway: stronger cross-session identity continuity, improving reuse of prior behavior in ranking.";
    }
    return "Optimization pathway: low-evidence row; only weak model update is inferable from available content.";
}
function inferRow(ev) {
    const features = extractFeatures(ev);
    const metrics = scoreFeatures(features, ev);
    const signals = signalsFromFeatures(features);
    const verdict = surplusVerdict(metrics.surplusScore);
    return {
        primitive: ev.primitive,
        rendering: renderingFromSignals(signals),
        surplus: {
            verdict,
            rationale: surplusRationale(metrics.surplusScore, metrics),
        },
        signals,
        metrics,
        uncertainty: uncertaintyFromMetrics(metrics),
        confidence: toConfidence((metrics.dataQualityScore + metrics.signalRichnessScore) / 2),
        evidence: `Source: ${ev.sourceFile}${ev.jsonPath ? ` @ ${ev.jsonPath}` : ""}. Preview: ${ev.rawPreview}`,
        loop: loopFromSignals(signals),
    };
}
function surplusCounts(events) {
    const counts = {
        likely_surplus: 0,
        mixed: 0,
        unclear: 0,
    };
    for (const ev of events) {
        counts[inferRow(ev).surplus.verdict] += 1;
    }
    return counts;
}
