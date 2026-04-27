"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInterpretationReport = buildInterpretationReport;
const archiveScore_1 = require("./archiveScore");
const density_1 = require("./density");
const extractionFlow_1 = require("./extractionFlow");
const loops_1 = require("./loops");
const patterns_1 = require("./patterns");
const infer_1 = require("./infer");
const mitigation_1 = require("./mitigation");
function primitiveTotals(events) {
    const m = {};
    for (const e of events) {
        m[e.primitive] = (m[e.primitive] ?? 0) + 1;
    }
    return m;
}
function buildInterpretationReport(archive, sourceFileName, density, mitigation) {
    const surplus = (0, infer_1.surplusCounts)(archive.events);
    const archiveScoreResult = (0, archiveScore_1.scoreArchive)(archive.events, density);
    const extractionFlowResult = (0, extractionFlow_1.computeExtractionFlow)(archive.events, density);
    const patternsResult = (0, patterns_1.computePatterns)(archive.events);
    const loopsResult = (0, loops_1.computeLoops)(archive.events, patternsResult);
    return {
        schema: "counter-render-report",
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sourceFileName,
        model: {
            version: infer_1.INFERENCE_MODEL_VERSION,
            featureRulesetVersion: infer_1.FEATURE_EXTRACTION_RULESET_VERSION,
            thresholds: infer_1.SURPLUS_THRESHOLDS,
            weights: infer_1.SURPLUS_WEIGHTS,
            confidenceCutoffs: infer_1.CONFIDENCE_CUTOFFS,
            counterfactualBorderlineRadius: infer_1.COUNTERFACTUAL_BORDERLINE_RADIUS,
            densityThresholds: density_1.DENSITY_THRESHOLDS,
            mitigationGates: mitigation_1.MITIGATION_GATES,
            archiveScore: {
                version: archiveScore_1.ARCHIVE_SCORE_MODEL_VERSION,
                weights: archiveScore_1.ARCHIVE_WEIGHTS,
                thresholds: archiveScore_1.ARCHIVE_THRESHOLDS,
                volumeNormalizer: archiveScore_1.ARCHIVE_VOLUME_NORMALIZER,
            },
            extractionFlow: {
                version: extractionFlow_1.EXTRACTION_FLOW_MODEL_VERSION,
                sessionGapMinutes: extractionFlow_1.SESSION_GAP_MINUTES,
            },
            patterns: {
                version: patterns_1.PATTERNS_MODEL_VERSION,
                sessionBuckets: patterns_1.SESSION_BUCKETS,
                bingeDayMultiplier: patterns_1.BINGE_DAY_MULTIPLIER,
            },
            loops: {
                version: loops_1.LOOPS_MODEL_VERSION,
            },
        },
        disclaimer: "Educational interpretation from an incomplete user data export. Not TikTok’s internal model. Row-level scores, signals, verdicts, and mitigation decisions are deterministic from disclosed row features under the model config snapshot above; only `generatedAt` is non-deterministic by design.",
        inventory: archive.inventory,
        parseWarnings: archive.warnings,
        summary: {
            eventCount: archive.events.length,
            inventoryFileCount: archive.inventory.length,
            surplusTotals: surplus,
            primitiveTotals: primitiveTotals(archive.events),
            temporalDensity: {
                windowMinutes: density.windowMinutes,
                datedEventCount: density.datedEventCount,
                tierCounts: density.tierCounts,
                peakTrailingWindow: density.peakTrailingWindow,
            },
            archive: archiveScoreResult,
            extractionFlow: extractionFlowResult,
            patterns: patternsResult,
            loops: loopsResult,
        },
        mitigation,
        events: archive.events.map((ev) => {
            const inf = (0, infer_1.inferRow)(ev);
            const tier = density.tierByEventId[ev.id] ?? "unknown";
            return {
                id: ev.id,
                at: ev.at,
                sourceFile: ev.sourceFile,
                jsonPath: ev.jsonPath,
                primitive: ev.primitive,
                label: ev.label,
                rawPreview: ev.rawPreview,
                inference: inf,
                temporalDensity: {
                    tier,
                    trailingWindowCount: density.countByEventId[ev.id] ?? 0,
                },
            };
        }),
    };
}
