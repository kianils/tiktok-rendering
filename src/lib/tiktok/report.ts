import {
  ARCHIVE_SCORE_MODEL_VERSION,
  ARCHIVE_THRESHOLDS,
  ARCHIVE_VOLUME_NORMALIZER,
  ARCHIVE_WEIGHTS,
  scoreArchive,
  type ArchiveScoreResult,
} from "./archiveScore";
import { DENSITY_THRESHOLDS, type DensityTier, type TemporalDensityResult } from "./density";
import {
  EXTRACTION_FLOW_MODEL_VERSION,
  SESSION_GAP_MINUTES,
  computeExtractionFlow,
  type ExtractionFlowResult,
} from "./extractionFlow";
import { LOOPS_MODEL_VERSION, computeLoops, type ArchiveLoops } from "./loops";
import {
  BINGE_DAY_MULTIPLIER,
  PATTERNS_MODEL_VERSION,
  SESSION_BUCKETS,
  computePatterns,
  type ArchivePatterns,
} from "./patterns";
import {
  FEATURE_EXTRACTION_RULESET_VERSION,
  INFERENCE_MODEL_VERSION,
  SURPLUS_THRESHOLDS,
  SURPLUS_WEIGHTS,
  CONFIDENCE_CUTOFFS,
  COUNTERFACTUAL_BORDERLINE_RADIUS,
  inferRow,
  surplusCounts,
} from "./infer";
import { MITIGATION_GATES, type MitigationItem } from "./mitigation";
import type { ParsedArchive } from "./types";

function primitiveTotals(events: ParsedArchive["events"]) {
  const m: Record<string, number> = {};
  for (const e of events) {
    m[e.primitive] = (m[e.primitive] ?? 0) + 1;
  }
  return m;
}

export type InterpretationReport = {
  schema: "counter-render-report";
  schemaVersion: 1;
  /**
   * ISO timestamp of report generation. This is the ONE intentionally
   * non-deterministic field in the report — it reflects *when* the report
   * was produced, not *what* was inferred. Row-level scores, signals,
   * verdicts, and mitigation text are all deterministic given the same
   * input archive and the same `model` config snapshot below.
   */
  generatedAt: string;
  sourceFileName: string | null;
  /**
   * Full deterministic config snapshot. Any two runs of this tool on the
   * same input ZIP with the same `model` values will produce identical
   * row-level scores, signals, verdicts, density tiers, and mitigation
   * gate decisions. Changing any of these requires a model/ruleset
   * version bump so downstream consumers can detect the change.
   */
  model: {
    version: string;
    featureRulesetVersion: string;
    thresholds: typeof SURPLUS_THRESHOLDS;
    weights: typeof SURPLUS_WEIGHTS;
    confidenceCutoffs: typeof CONFIDENCE_CUTOFFS;
    counterfactualBorderlineRadius: number;
    densityThresholds: typeof DENSITY_THRESHOLDS;
    mitigationGates: typeof MITIGATION_GATES;
    archiveScore: {
      version: typeof ARCHIVE_SCORE_MODEL_VERSION;
      weights: typeof ARCHIVE_WEIGHTS;
      thresholds: typeof ARCHIVE_THRESHOLDS;
      volumeNormalizer: typeof ARCHIVE_VOLUME_NORMALIZER;
    };
    extractionFlow: {
      version: typeof EXTRACTION_FLOW_MODEL_VERSION;
      sessionGapMinutes: typeof SESSION_GAP_MINUTES;
    };
    patterns: {
      version: typeof PATTERNS_MODEL_VERSION;
      sessionBuckets: typeof SESSION_BUCKETS;
      bingeDayMultiplier: typeof BINGE_DAY_MULTIPLIER;
    };
    loops: {
      version: typeof LOOPS_MODEL_VERSION;
    };
  };
  disclaimer: string;
  inventory: { path: string }[];
  parseWarnings: string[];
  summary: {
    eventCount: number;
    inventoryFileCount: number;
    surplusTotals: ReturnType<typeof surplusCounts>;
    primitiveTotals: Record<string, number>;
    temporalDensity: {
      windowMinutes: number;
      datedEventCount: number;
      tierCounts: TemporalDensityResult["tierCounts"];
      peakTrailingWindow: TemporalDensityResult["peakTrailingWindow"];
    };
    archive: ArchiveScoreResult;
    extractionFlow: ExtractionFlowResult;
    patterns: ArchivePatterns;
    loops: ArchiveLoops;
  };
  mitigation: MitigationItem[];
  events: Array<{
    id: string;
    at: string | null;
    sourceFile: string;
    jsonPath?: string;
    primitive: string;
    label: string;
    rawPreview: string;
    inference: ReturnType<typeof inferRow>;
    temporalDensity: {
      tier: DensityTier;
      trailingWindowCount: number;
    };
  }>;
};

export function buildInterpretationReport(
  archive: ParsedArchive,
  sourceFileName: string | null,
  density: TemporalDensityResult,
  mitigation: MitigationItem[],
): InterpretationReport {
  const surplus = surplusCounts(archive.events);
  const archiveScoreResult = scoreArchive(archive.events, density);
  const extractionFlowResult = computeExtractionFlow(archive.events, density);
  const patternsResult = computePatterns(archive.events);
  const loopsResult = computeLoops(archive.events, patternsResult);
  return {
    schema: "counter-render-report",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceFileName,
    model: {
      version: INFERENCE_MODEL_VERSION,
      featureRulesetVersion: FEATURE_EXTRACTION_RULESET_VERSION,
      thresholds: SURPLUS_THRESHOLDS,
      weights: SURPLUS_WEIGHTS,
      confidenceCutoffs: CONFIDENCE_CUTOFFS,
      counterfactualBorderlineRadius: COUNTERFACTUAL_BORDERLINE_RADIUS,
      densityThresholds: DENSITY_THRESHOLDS,
      mitigationGates: MITIGATION_GATES,
      archiveScore: {
        version: ARCHIVE_SCORE_MODEL_VERSION,
        weights: ARCHIVE_WEIGHTS,
        thresholds: ARCHIVE_THRESHOLDS,
        volumeNormalizer: ARCHIVE_VOLUME_NORMALIZER,
      },
      extractionFlow: {
        version: EXTRACTION_FLOW_MODEL_VERSION,
        sessionGapMinutes: SESSION_GAP_MINUTES,
      },
      patterns: {
        version: PATTERNS_MODEL_VERSION,
        sessionBuckets: SESSION_BUCKETS,
        bingeDayMultiplier: BINGE_DAY_MULTIPLIER,
      },
      loops: {
        version: LOOPS_MODEL_VERSION,
      },
    },
    disclaimer:
      "Educational interpretation from an incomplete user data export. Not TikTok’s internal model. Row-level scores, signals, verdicts, and mitigation decisions are deterministic from disclosed row features under the model config snapshot above; only `generatedAt` is non-deterministic by design.",
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
      const inf = inferRow(ev);
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
