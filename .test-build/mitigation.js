"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MITIGATION_GATES = void 0;
exports.buildMitigationAdvice = buildMitigationAdvice;
const density_1 = require("./density");
const infer_1 = require("./infer");
/**
 * Thresholds that gate whether a given mitigation card is surfaced.
 *
 * All values are "share of rows in the archive" unless otherwise noted.
 * They are tuned to produce at most a handful of cards on a typical export;
 * the intent is to read as harm-reduction guidance keyed to the user's own
 * evidence, not as a generic scare sheet.
 *
 * `densePeakWindowMin` is in event-count units on the trailing-window metric
 * from density.ts; it is intentionally lower than `DENSITY_THRESHOLDS.high`
 * so that a single large burst can trigger the rhythm-interruption card even
 * when no individual row crossed the `high` tier.
 */
exports.MITIGATION_GATES = {
    attentionShare: 0.35,
    intentShare: 0.08,
    socialShare: 0.1,
    likelySurplusShare: 0.45,
    densePeakWindowMin: 20,
};
function countSignals(events) {
    const m = {};
    for (const e of events) {
        const inf = (0, infer_1.inferRow)(e);
        for (const s of inf.signals)
            m[s] = (m[s] ?? 0) + 1;
    }
    return m;
}
/** Plain-language harm-reduction ideas tied to what the export suggests—no “secret bypass” claims. */
function buildMitigationAdvice(input) {
    const items = [];
    const { events, surplusTotals, density } = input;
    const n = events.length || 1;
    const sig = countSignals(events);
    const attentionShare = (sig.watch_time_or_consumption_signals ?? 0) / n;
    const intentShare = (sig.text_query_intent_signals ?? 0) / n;
    const socialShare = (sig.social_graph_interaction_signals ?? 0) / n;
    // Rhythm-interruption gate: either any row hit the `high` density tier
    // (crossed DENSITY_THRESHOLDS.high events in the trailing window), OR the
    // archive's single densest trailing window crossed `densePeakWindowMin`.
    // The second clause is a softer trigger so a short-but-extreme burst still
    // surfaces the card even if no row individually crossed `high`.
    const hadHighDensityRow = density.tierCounts.high > 0;
    const peakCount = density.peakTrailingWindow?.count ?? 0;
    const peakCrossedSoftGate = peakCount >= exports.MITIGATION_GATES.densePeakWindowMin;
    if (hadHighDensityRow || peakCrossedSoftGate) {
        items.push({
            title: "Interrupt dense sessions",
            body: "Your export shows stretches where many dated events fall inside a short clock window. That pattern is exactly the kind of rich, fast-updating trace surveillance capitalism treats as behavioral surplus: small actions, tight spacing, lots of teachable structure. Mitigation is not mystical—break rhythm (time boxes, no-scroll windows, grayscale, removing the app from your home screen) so the surplus stream thins out.",
            evidenceBasis: `Trailing ${density.windowMinutes}-min windows: ${density.tierCounts.high} row(s) at 'high' (>=${density_1.DENSITY_THRESHOLDS.high} events), peak window count ${peakCount}.`,
            claimBoundary: "Shows dense trace generation, not proof of a specific internal ranking objective.",
        });
    }
    if (attentionShare >= exports.MITIGATION_GATES.attentionShare) {
        items.push({
            title: "Attention histories are surplus-heavy",
            body: "A large share of rows look like attention or browsing substrate. Even without perfect watch-time in the ZIP, chronicles of exposure are more than any single video ‘needs’; they feed retention models. Consider stricter limits on when you open the feed, and periodic resets of interests inside TikTok’s own settings where available.",
            evidenceBasis: `watch_time_or_consumption_signals present on ${Math.round(attentionShare * 100)}% of rows (gate: ${Math.round(exports.MITIGATION_GATES.attentionShare * 100)}%).`,
            claimBoundary: "Infers likely reuse potential, not exact ranking weights.",
        });
    }
    if (intentShare >= exports.MITIGATION_GATES.intentShare) {
        items.push({
            title: "Search text is legible intent",
            body: "Queries render you as goals in plain language—high leverage for matching and ads. If you want less extraction, search less inside the app for sensitive goals, avoid treating TikTok as a general search engine, and review privacy/ad personalization settings in official menus.",
            evidenceBasis: `text_query_intent_signals present on ${Math.round(intentShare * 100)}% of rows (gate: ${Math.round(exports.MITIGATION_GATES.intentShare * 100)}%).`,
            claimBoundary: "Does not assert ad-targeting implementation details.",
        });
    }
    if (socialShare >= exports.MITIGATION_GATES.socialShare) {
        items.push({
            title: "Social traces knit a graph",
            body: "Comments and messages become relational evidence. Segmenting ‘public’ vs ‘private’ social use (separate accounts or contexts) reduces how completely one graph can summarize you—always within platform rules and your own risk tolerance.",
            evidenceBasis: `social_graph_interaction_signals present on ${Math.round(socialShare * 100)}% of rows (gate: ${Math.round(exports.MITIGATION_GATES.socialShare * 100)}%).`,
            claimBoundary: "Does not imply direct graph-rank coefficients or guaranteed feed outcomes.",
        });
    }
    if (surplusTotals.likely_surplus / n >= exports.MITIGATION_GATES.likelySurplusShare) {
        items.push({
            title: "Many rows read as likely surplus",
            body: "Heuristically, much of this archive looks like prediction-ready substrate, not one-off service residue. That aligns with Zuboff’s point: the product can run while the surplus accumulates elsewhere. Use official data tools (download, delete account categories if offered) and habit changes rather than third-party scrapers.",
            evidenceBasis: `${Math.round((surplusTotals.likely_surplus / n) * 100)}% of rows classified likely_surplus (gate: ${Math.round(exports.MITIGATION_GATES.likelySurplusShare * 100)}%).`,
            claimBoundary: "Classification is deterministic from observed traces, not legal proof of misuse.",
        });
    }
    if (items.length === 0 && n > 0) {
        items.push({
            title: "Keep the loop visible",
            body: "Even a thinner export still participates in rendering whenever you return to the feed. Revisit Settings and privacy regularly, prefer official data downloads for inspection, and treat this tool as literacy—not a guarantee of what TikTok stores internally.",
            evidenceBasis: "Low signal prevalence with ongoing feed activity traces.",
            claimBoundary: "Learning prompt only; no claim that low-signal rows imply low collection in production systems.",
        });
    }
    if (items.length < 5) {
        items.push({
            title: "Account hygiene (official paths only)",
            body: "Use TikTok’s in-app privacy, ad personalization, and data-download settings. This project never uploads your ZIP; whatever you do on TikTok’s side should follow their terms and your regional rights (for example access or deletion requests where applicable).",
            evidenceBasis: "General best-practice mitigation applied to all archives.",
            claimBoundary: "Policy guidance; does not change historical collection already in platform logs.",
        });
    }
    return items.slice(0, 6);
}
