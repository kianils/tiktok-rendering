"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ARCHIVE_SCORE_MODEL_VERSION,
  ARCHIVE_THRESHOLDS,
  scoreArchive,
  type ArchiveVerdict,
} from "@/lib/tiktok/archiveScore";
import { DENSITY_THRESHOLDS, analyzeTemporalDensity, densityLabel } from "@/lib/tiktok/density";
import {
  EXTRACTION_FLOW_MODEL_VERSION,
  SESSION_GAP_MINUTES,
  computeExtractionFlow,
} from "@/lib/tiktok/extractionFlow";
import { computeLoops } from "@/lib/tiktok/loops";
import { SESSION_BUCKETS, computePatterns } from "@/lib/tiktok/patterns";
import {
  RL_ESTIMATOR_CONFIG,
  RL_TRACE_MODEL_VERSION,
  STATE_FRIENDLY_NAME,
  computeRLTrace,
  type RLState,
} from "@/lib/tiktok/rlTrace";
import {
  SENTIMENT_MODEL_VERSION,
  extractTextForSentiment,
  sentimentScore,
  type SentimentResult,
} from "@/lib/tiktok/sentiment";
import {
  FEATURE_EXTRACTION_RULESET_VERSION,
  INFERENCE_MODEL_VERSION,
  SURPLUS_THRESHOLDS,
  inferRow,
  surplusCounts,
} from "@/lib/tiktok/infer";
import { buildMitigationAdvice } from "@/lib/tiktok/mitigation";
import { parseTikTokExportZip } from "@/lib/tiktok/parseExport";
import { buildInterpretationReport } from "@/lib/tiktok/report";
import type { ArchiveEvent, ParsedArchive, RowInference } from "@/lib/tiktok/types";

function archiveVerdictLabel(v: ArchiveVerdict): string {
  if (v === "high_surplus_archive") return "High-surplus archive";
  if (v === "moderate_surplus_archive") return "Moderate-surplus archive";
  return "Low-surplus archive";
}

function archiveVerdictBadge(v: ArchiveVerdict): string {
  if (v === "high_surplus_archive")
    return "bg-violet-100 text-violet-950 dark:bg-violet-900/45 dark:text-violet-50 border border-violet-200/80 dark:border-violet-800/80";
  if (v === "moderate_surplus_archive")
    return "bg-sky-100 text-sky-950 dark:bg-sky-900/40 dark:text-sky-50 border border-sky-200/80 dark:border-sky-800/80";
  return "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700";
}

function badge(conf: "low" | "medium" | "high") {
  const map = {
    low: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
    medium: "bg-amber-100 text-amber-950 dark:bg-amber-900/40 dark:text-amber-100",
    high: "bg-rose-100 text-rose-950 dark:bg-rose-900/40 dark:text-rose-50",
  } as const;
  return map[conf];
}

function surplusBadge(verdict: "likely_surplus" | "mixed" | "unclear") {
  const map = {
    likely_surplus:
      "bg-violet-100 text-violet-950 dark:bg-violet-900/45 dark:text-violet-50 border border-violet-200/80 dark:border-violet-800/80",
    mixed:
      "bg-sky-100 text-sky-950 dark:bg-sky-900/40 dark:text-sky-50 border border-sky-200/80 dark:border-sky-800/80",
    unclear: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700",
  } as const;
  return map[verdict];
}

function surplusLabel(verdict: "likely_surplus" | "mixed" | "unclear") {
  if (verdict === "likely_surplus") return "Likely behavioral surplus";
  if (verdict === "mixed") return "Mixed (visible act + surplus accumulation)";
  return "Unclear from fragment";
}

function densityBadgeClass(tier: "unknown" | "normal" | "elevated" | "high") {
  const map = {
    high: "bg-fuchsia-100 text-fuchsia-950 dark:bg-fuchsia-950/50 dark:text-fuchsia-50 border border-fuchsia-300/80 dark:border-fuchsia-800",
    elevated:
      "bg-orange-100 text-orange-950 dark:bg-orange-950/45 dark:text-orange-50 border border-orange-300/80 dark:border-orange-900",
    normal: "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/35 dark:text-emerald-50 border border-emerald-200 dark:border-emerald-900",
    unknown: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-600",
  } as const;
  return map[tier];
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Unknown time";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type DashboardView = "rendering" | "mitigation" | "surplus";

// Rendering view is a guided sequence. Each step gets its own screen
// with Prev/Next; the reader never sees more than one conceptual block
// at a time, which kills the scroll wall.
type RenderingStepId = 1 | 2 | 3;
type RenderingStep = {
  id: RenderingStepId;
  label: string;
  title: string;
};
// Typed as a plain readonly array (not a tuple) so indexing at an
// arbitrary number is treated as `RenderingStep | undefined` under
// noUncheckedIndexedAccess, which matches our runtime guards and
// avoids the tuple-length TS error. Step 4 "Your stats" was absorbed
// into Step 3 sub-step 3 ("Your shape"), which is where the patterns
// portrait now lives.
const RENDERING_STEPS: ReadonlyArray<RenderingStep> = [
  { id: 1, label: "Capture", title: "How your data gets captured" },
  { id: 2, label: "Prediction", title: "How easily a model predicts you" },
  { id: 3, label: "Loop", title: "How prediction becomes a loop" },
];

export function DashboardClient() {
  const [status, setStatus] = useState<
    "idle" | "reading" | "processing" | "ready" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [archive, setArchive] = useState<ParsedArchive | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [learningNotes, setLearningNotes] = useState<Record<string, string>>({});
  const [view, setView] = useState<DashboardView>("rendering");
  const [renderingStep, setRenderingStep] = useState<RenderingStepId>(1);
  // Sub-stepper inside Step 1. Three screens:
  //   (1) Capture framing + archive-level snapshot (combined).
  //   (2) One moment broken into signals.
  //   (3) What the model learned from that moment.
  // Advancing past the final sub-step rolls to the outer Step 2.
  const [captureSubStep, setCaptureSubStep] = useState<1 | 2 | 3>(1);
  // Carousel index for the dimensions breakdown on sub-step 2. Groups
  // are shown in the order: lost (red), captured (green), flattened
  // (yellow/amber), inferred (sky blue). Empty groups are skipped.
  const [dimensionGroupIndex, setDimensionGroupIndex] = useState(0);
  // Sub-stepper inside Step 2 (Prediction). Two screens:
  //   (1) Top rules walked as a chain of behaviour ("after A you B, then…").
  //   (2) The single cheapest rule + hardest state combined.
  // Advancing past the final sub-step rolls to the outer Step 3.
  const [predictionSubStep, setPredictionSubStep] = useState<1 | 2>(1);
  // Carousel index for Step 2 sub-step 1's "follow one chain" view.
  const [chainStepIndex, setChainStepIndex] = useState(0);
  // Sub-stepper inside Step 3 (Loop). Three screens:
  //   (1) Your loops, walked one metric at a time.
  //   (2) Your heaviest days, walked one at a time.
  //   (3) Your shape: the portrait that falls out of the patterns.
  const [loopSubStep, setLoopSubStep] = useState<1 | 2 | 3>(1);
  // Carousel index for the three loop metrics on sub-step 1.
  const [loopMetricIndex, setLoopMetricIndex] = useState<0 | 1 | 2>(0);
  // Carousel index for the heaviest-days list on sub-step 2.
  const [bingeDayIndex, setBingeDayIndex] = useState(0);
  // Sub-stepper inside the Mitigation view. Three screens, one per
  // reading: Polarization, Compulsion, Emotional targeting. The
  // "Things you can actually do" row sits above the stepper and
  // stays visible across all three.
  const [mitigationSubStep, setMitigationSubStep] = useState<1 | 2 | 3>(1);
  // Gate the landing hero behind a brief Zuboff quote cover on first
  // load. Reveals itself on click, escape, or a fallback timer so the
  // user is never stuck.
  const [quoteDismissed, setQuoteDismissed] = useState(false);
  useEffect(() => {
    if (quoteDismissed) return;
    const timer = setTimeout(() => setQuoteDismissed(true), 9000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
        setQuoteDismissed(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [quoteDismissed]);

  const onFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setError(null);
    setStatus("reading");
    setFileName(file.name);
    try {
      const parsed = await parseTikTokExportZip(file);
      setStatus("processing");
      // One frame before flipping state so the spinner paints before all
      // the heavy useMemos kick off on the new archive reference.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      setArchive(parsed);
      setLearningNotes({});
      setView("rendering");
      setRenderingStep(1);
      setCaptureSubStep(1);
      setDimensionGroupIndex(0);
      setPredictionSubStep(1);
      setChainStepIndex(0);
      setLoopSubStep(1);
      setLoopMetricIndex(0);
      setBingeDayIndex(0);
      setMitigationSubStep(1);
      setStatus("ready");
    } catch (e) {
      setError((e as Error).message);
      setArchive(null);
      setStatus("error");
    }
  }, []);

  const surplusTotals = useMemo(() => {
    if (!archive) return null;
    return surplusCounts(archive.events);
  }, [archive]);

  const density = useMemo(() => {
    if (!archive) return null;
    return analyzeTemporalDensity(archive.events, 10);
  }, [archive]);

  const archiveScoreResult = useMemo(() => {
    if (!archive || !density) return null;
    return scoreArchive(archive.events, density);
  }, [archive, density]);

  const extractionFlow = useMemo(() => {
    if (!archive || !density) return null;
    return computeExtractionFlow(archive.events, density);
  }, [archive, density]);

  const patterns = useMemo(() => {
    if (!archive) return null;
    return computePatterns(archive.events);
  }, [archive]);

  const loops = useMemo(() => {
    if (!archive || !patterns) return null;
    return computeLoops(archive.events, patterns);
  }, [archive, patterns]);

  const rlTrace = useMemo(() => {
    if (!archive || !density) return null;
    return computeRLTrace(archive.events, density);
  }, [archive, density]);

  // Showcase row for the "Rendering in action" panel. The panel shows the
  // lived act, then — as a table of dimensions — what got captured, what
  // got flattened to a number, and what was never stored. Picking strategy:
  // prefer events with substantive natural-language text (so the sentiment
  // rendering step lands on something meaningful), then highest surplus.
  //
  // Alongside the single picked event, we also aggregate archive-level
  // rendering stats so the Step 1 panel can answer "how representative is
  // this row?" — how many events have text, how many have sentiment hits,
  // what share of the archive this single showcase stands in for.
  const showcase = useMemo(() => {
    if (!archive) return null;

    type Candidate = {
      ev: ArchiveEvent;
      inf: RowInference;
      text: string | null;
      textWordCount: number;
      sentiment: SentimentResult | null;
      parsedFields: { key: string; value: string }[] | null;
    };

    /**
     * Extract (key, value) pairs from a rawPreview. Tries JSON parse,
     * then newline/2+-space delimited `Key: value` blocks, then a
     * flat-line KV regex. Matches the extractor used for sentiment so
     * the "raw stored" display and the text extraction agree on what
     * the record contains.
     */
    const extractFields = (
      rawPreview: string,
    ): { key: string; value: string }[] | null => {
      try {
        const obj = JSON.parse(rawPreview);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return Object.entries(obj as Record<string, unknown>).map(([k, v]) => ({
            key: k,
            value:
              typeof v === "string"
                ? v
                : typeof v === "number" || typeof v === "boolean" || v === null
                  ? String(v)
                  : JSON.stringify(v),
          }));
        }
      } catch {
        // fall through to text parsing
      }
      // Key:value block (newline or 2+-space separated).
      const lineFields: { key: string; value: string }[] = [];
      const lines = rawPreview
        .split(/\r?\n|\s{2,}/g)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^([A-Za-z][A-Za-z _-]{0,40}?)\s*:\s*(.+)$/);
        if (m) lineFields.push({ key: m[1].trim(), value: m[2].trim() });
      }
      if (lineFields.length >= 2) return lineFields;
      // Fallback: flat KV regex.
      const flatFields: { key: string; value: string }[] = [];
      const flatPattern =
        /([A-Z][A-Za-z ]{0,40}?)\s*:\s+(.+?)(?=\s+[A-Z][A-Za-z ]{0,40}?\s*:|$)/g;
      let m: RegExpExecArray | null;
      while ((m = flatPattern.exec(rawPreview)) !== null) {
        flatFields.push({ key: m[1].trim(), value: m[2].trim() });
      }
      return flatFields.length > 0 ? flatFields : null;
    };

    // Archive-level tallies, filled while scanning candidates.
    let eventsWithRawPreview = 0;
    let eventsWithExtractableText = 0;
    let eventsWithSentimentHits = 0;

    const candidates: Candidate[] = [];
    for (const ev of archive.events) {
      if (!ev.rawPreview || ev.rawPreview.trim().length === 0) continue;
      eventsWithRawPreview += 1;
      const inf = inferRow(ev);
      const text = extractTextForSentiment(ev.label, ev.rawPreview);
      const textWordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
      if (text && textWordCount >= 2) eventsWithExtractableText += 1;
      const sentiment = text && textWordCount >= 2 ? sentimentScore(text) : null;
      if (sentiment && sentiment.hits.length > 0) eventsWithSentimentHits += 1;
      const parsedFields = extractFields(ev.rawPreview);
      candidates.push({ ev, inf, text, textWordCount, sentiment, parsedFields });
    }
    if (candidates.length === 0) return null;

    // Ranking for the rendering showcase. Priorities, in order:
    //   1. Rows the sentiment classifier has hits on — these produce the
    //      most concrete "text → number" demo. Prefer stronger |normalized|.
    //   2. Rows with any extracted text (even if neutral), so the text row
    //      of the dimensions table has something to show.
    //   3. Fall back to highest surplus / signal richness.
    candidates.sort((a, b) => {
      const aHits = a.sentiment?.hits.length ?? 0;
      const bHits = b.sentiment?.hits.length ?? 0;
      if (aHits > 0 || bHits > 0) {
        if (aHits !== bHits) return bHits - aHits;
        const aAbs = Math.abs(a.sentiment?.normalized ?? 0);
        const bAbs = Math.abs(b.sentiment?.normalized ?? 0);
        if (aAbs !== bAbs) return bAbs - aAbs;
      }
      const aHasText = a.textWordCount >= 2 ? 1 : 0;
      const bHasText = b.textWordCount >= 2 ? 1 : 0;
      if (aHasText !== bHasText) return bHasText - aHasText;
      if (a.inf.metrics.surplusScore !== b.inf.metrics.surplusScore)
        return b.inf.metrics.surplusScore - a.inf.metrics.surplusScore;
      return b.inf.metrics.signalRichnessScore - a.inf.metrics.signalRichnessScore;
    });
    const pick = candidates[0];
    const sentiment = pick.sentiment;

    // Build the dimensions table. Each entry is one aspect of the lived
    // moment, classified by how rendering treated it.
    type Status = "captured" | "flattened" | "inferred" | "lost";
    type Dim = {
      aspect: string;
      renderedAs: string | null;
      status: Status;
      note: string;
    };

    const fieldMap = new Map<string, string>();
    for (const f of pick.parsedFields ?? []) fieldMap.set(f.key.toLowerCase(), f.value);
    const findField = (keys: string[]) => {
      for (const k of keys) {
        for (const [mk, v] of fieldMap) if (mk.includes(k)) return { key: mk, value: v };
      }
      return null;
    };
    const truncateValue = (s: string, n: number) =>
      s.length <= n ? s : `${s.slice(0, n - 1)}…`;

    const dims: Dim[] = [];

    // 1. The thing you interacted with
    const idField = findField(["id", "video", "url", "link", "post", "item"]);
    dims.push({
      aspect: "The specific thing you interacted with",
      renderedAs: idField ? `${idField.key} = ${truncateValue(idField.value, 36)}` : null,
      status: idField ? "captured" : "lost",
      note: idField
        ? "A stable identifier that lets the system re-link this exact item to everything else you touch."
        : "Not visible in this row fragment.",
    });

    // 2. Time
    const timeField = findField(["time", "date", "timestamp"]);
    const timeRender = pick.ev.at ?? timeField?.value ?? null;
    dims.push({
      aspect: "The moment in time it happened",
      renderedAs: timeRender
        ? `timestamp = ${pick.ev.at ? formatWhen(pick.ev.at) : truncateValue(timeField!.value, 36)}`
        : null,
      status: timeRender ? "captured" : "lost",
      note: "Timestamps let sequences, sessions, and daily rhythms be reconstructed after the fact.",
    });

    // 3. Duration / dwell
    const durationField = findField(["duration", "ms", "seconds", "watch", "length", "dwell"]);
    dims.push({
      aspect: "How long you paused or engaged",
      renderedAs: durationField
        ? `${durationField.key} = ${truncateValue(durationField.value, 36)}`
        : null,
      status: durationField ? "captured" : "lost",
      note: durationField
        ? "Dwell time is a major behavioral-surplus signal, the act of waiting is itself a feature."
        : "This row does not disclose how long the interaction lasted.",
    });

    // 4 & 5. Text and its emotional valence
    if (pick.text && sentiment) {
      dims.push({
        aspect: "The words you typed, or that appeared in the content",
        renderedAs: `text string (${pick.textWordCount} words)`,
        status: "captured",
        note: "Kept verbatim, not yet a feature but ready to be embedded or scored.",
      });
      dims.push({
        aspect: "The emotional weight of that language",
        renderedAs: `sentiment = ${sentiment.normalized.toFixed(2)}  →  "${sentiment.label}"`,
        status: "flattened",
        note: `A lexicon model we ran locally collapsed ${sentiment.hits.length || "zero"} emotion-bearing words into one number. See below for the step-by-step.`,
      });
    }

    // 6. Reason / intent — never captured
    dims.push({
      aspect: "Your reason for doing this, right now",
      renderedAs: null,
      status: "lost",
      note: "There is no 'why' field anywhere in a TikTok export. Intent must be guessed statistically from neighboring events.",
    });

    // 7. Body / context — never captured
    dims.push({
      aspect: "Your mood, body, and surroundings",
      renderedAs: null,
      status: "lost",
      note: "The record carries no fatigue, no mood, no room. Only the trace of actions remains.",
    });

    // 8. Cross-session identity
    const linkField = findField(["user", "device", "ip", "session", "account"]);
    dims.push({
      aspect: "Which past-you this event belongs to",
      renderedAs: linkField
        ? `${linkField.key} = ${truncateValue(linkField.value, 36)}`
        : "inferred from session timing + device fingerprint",
      status: linkField ? "captured" : "inferred",
      note: linkField
        ? "Linkage keys stitch this row to every other row you have ever produced."
        : "Even without an explicit user id, gaps between events and device signals let sessions be recovered.",
    });

    return {
      pick,
      sentiment,
      dims,
      archiveStats: {
        eventsTotal: archive.events.length,
        eventsWithRawPreview,
        eventsWithExtractableText,
        eventsWithSentimentHits,
      },
    };
  }, [archive]);

  const mitigation = useMemo(() => {
    if (!archive || !surplusTotals || !density) return null;
    return buildMitigationAdvice({
      events: archive.events,
      surplusTotals,
      density,
    });
  }, [archive, surplusTotals, density]);

  const rows = useMemo(() => {
    if (!archive || !density) return [];
    return archive.events.slice(0, 200).map((ev: ArchiveEvent) => ({
      ev,
      inf: inferRow(ev),
      densityTier: density.tierByEventId[ev.id] ?? "unknown",
      densityCount: density.countByEventId[ev.id] ?? 0,
      densityPercentile: density.percentileByEventId[ev.id] ?? 0,
      windowMinutes: density.windowMinutes,
    }));
  }, [archive, density]);

  const onDownloadReport = useCallback(() => {
    if (!archive || !density || !mitigation) return;
    const doc = buildInterpretationReport(archive, fileName, density, mitigation);
    const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19);
    downloadJson(doc, `counter-render-report-${stamp}.json`);
  }, [archive, fileName, density, mitigation]);

  const isLoading = status === "reading" || status === "processing";
  const isLoaded = Boolean(archive) && status === "ready";

  return (
    <div
      className={
        isLoaded
          ? "dark min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-100"
          : "min-h-screen"
      }
    >
      {isLoaded ? (
        <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/60">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-sm font-bold text-zinc-900">
                CR
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
                  Counter-rendering prototype
                </p>
                <p className="text-sm font-medium text-zinc-100">
                  {fileName ? (
                    <span className="font-mono text-xs text-zinc-300">{fileName}</span>
                  ) : (
                    "Archive loaded"
                  )}
                  {archive ? (
                    <span className="ml-2 text-xs font-normal text-zinc-400">
                      · {archive.events.length.toLocaleString()} events
                    </span>
                  ) : null}
                </p>
              </div>
            </div>

            <nav
              className="flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 p-1"
              aria-label="Dashboard view"
            >
              <button
                type="button"
                onClick={() => setView("rendering")}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  view === "rendering"
                    ? "bg-zinc-100 text-zinc-900 shadow"
                    : "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
                aria-pressed={view === "rendering"}
              >
                Rendering story
              </button>
              <button
                type="button"
                onClick={() => setView("mitigation")}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  view === "mitigation"
                    ? "bg-zinc-100 text-zinc-900 shadow"
                    : "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
                aria-pressed={view === "mitigation"}
              >
                Mitigation
              </button>
              <button
                type="button"
                onClick={() => setView("surplus")}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  view === "surplus"
                    ? "bg-zinc-100 text-zinc-900 shadow"
                    : "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
                aria-pressed={view === "surplus"}
              >
                Surplus analysis
              </button>
            </nav>

            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-800">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-3.5 w-3.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Replace archive
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </header>
      ) : null}

      {/* ZUBOFF QUOTE — a brief gate shown before anything else. The
          user taught us what "rendering" means; we open with her own
          words before asking for a data upload. Auto-advances after 9s
          or on any key; click also dismisses. */}
      {!quoteDismissed ? (
        <button
          type="button"
          onClick={() => setQuoteDismissed(true)}
          aria-label="Continue to the tool"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black px-6 py-10 text-left transition-opacity duration-500"
        >
          <div className="max-w-2xl animate-fade-in-up text-center">
            <p
              className="animate-fade-in text-[10px] font-semibold uppercase tracking-[0.3em] text-zinc-500"
              style={{ animationDelay: "0ms" }}
            >
              From the introduction to
            </p>
            <p
              className="animate-fade-in mt-2 text-sm font-medium italic text-zinc-300"
              style={{ animationDelay: "250ms" }}
            >
              The Age of Surveillance Capitalism
            </p>
            <p
              className="animate-fade-in mt-1 text-[11px] uppercase tracking-wider text-zinc-500"
              style={{ animationDelay: "500ms" }}
            >
              Shoshana Zuboff, 2019
            </p>

            <blockquote
              className="animate-fade-in-up mt-8 text-balance text-xl leading-relaxed text-zinc-100 sm:text-2xl"
              style={{ animationDelay: "800ms" }}
            >
              &ldquo;Surveillance capitalism&apos;s technologies are designed to{" "}
              <span className="text-white">render our experience into data</span>, as in
              rendering oil from fat, typically outside of our awareness, let alone our
              consent.&rdquo;
            </blockquote>

            <p
              className="animate-fade-in mt-10 text-xs text-zinc-500"
              style={{ animationDelay: "1600ms" }}
            >
              Press any key or click to continue.
            </p>
          </div>
        </button>
      ) : null}

      {/* LANDING HERO — shown when no archive has been loaded yet.
          Full-screen black with staggered fade-in: brand chip → headline
          → subtitle → drop target → "What is this?" expandable → data
          export link. The idea is to make the first impression feel
          deliberate, dark, calm, and not scroll-heavy: the reader gets
          one clear question ("What did TikTok render you into?"), one
          clear action (drop the ZIP), and optional deeper context they
          can choose to reveal. */}
      {!isLoaded ? (
        <div className="dark fixed inset-0 z-40 flex items-center justify-center bg-black px-4 py-10 sm:px-6">
          <div className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
            <p
              className="animate-fade-in-up text-[10px] font-semibold uppercase tracking-[0.3em] text-zinc-500"
              style={{ animationDelay: "0ms" }}
            >
              Counter-rendering prototype
            </p>

            <h1
              className="animate-fade-in-up text-balance text-4xl font-semibold leading-[1.05] text-white sm:text-5xl"
              style={{ animationDelay: "120ms" }}
            >
              What did TikTok render you into?
            </h1>

            <p
              className="animate-fade-in-up max-w-xl text-balance text-base leading-relaxed text-zinc-400 sm:text-lg"
              style={{ animationDelay: "320ms" }}
            >
              Drop in your TikTok data export. On <em>your own</em> archive, we show
              what the platform extracted from you, how accurately a learning system
              can predict your next move, and how that prediction closes into a loop
              around your behaviour.
            </p>

            <label
              className="animate-fade-in-up group mt-2 flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/60 px-6 py-8 transition hover:border-zinc-500 hover:bg-zinc-900/80"
              style={{ animationDelay: "540ms" }}
            >
              {isLoading ? (
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-block h-5 w-5 animate-spin-smooth rounded-full border-2 border-zinc-700 border-t-zinc-100"
                  />
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-medium text-zinc-100">
                      {status === "reading"
                        ? "Reading archive…"
                        : "Extracting features and fitting models…"}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {status === "reading"
                        ? "Parsing ZIP locally in your browser."
                        : "Computing Markov chain, Laplace smoothing, bootstrap CIs."}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className="h-8 w-8 text-zinc-500 transition group-hover:text-zinc-200"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 16V4m0 0L3 8m4-4l4 4m6 4v8m0 0l4-4m-4 4l-4-4"
                    />
                  </svg>
                  <span className="text-base font-medium text-zinc-100">
                    Drop your TikTok export (.zip)
                  </span>
                  <span className="text-xs text-zinc-500">
                    Parsed locally in your browser. Never uploaded.
                  </span>
                </>
              )}
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              />
            </label>

            {status === "error" && error ? (
              <p className="animate-fade-in text-sm text-rose-400">
                Couldn&apos;t read that file: {error}
              </p>
            ) : null}

            <details
              className="animate-fade-in-up group w-full rounded-xl border border-zinc-800 bg-zinc-950/60 text-left transition hover:border-zinc-700"
              style={{ animationDelay: "760ms" }}
            >
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-zinc-200">
                <span>What is this tool?</span>
                <span
                  aria-hidden
                  className="text-xs text-zinc-500 transition group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <div className="border-t border-zinc-800 px-4 py-4 text-sm leading-relaxed text-zinc-300">
                <p>
                  This tool is a browser-only reading of your TikTok data export,
                  built around three ideas from Shoshana Zuboff&apos;s{" "}
                  <em>The Age of Surveillance Capitalism</em>:
                </p>
                <ul className="mt-3 space-y-2 pl-4">
                  <li className="relative pl-4">
                    <span className="absolute left-0 top-[0.5em] h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="font-medium text-zinc-100">Rendering</span>,
                    every lived gesture (a scroll, a tap, a search) is translated
                    into machine-readable rows. Step 1 takes one of those moments
                    apart and shows what survived as data.
                  </li>
                  <li className="relative pl-4">
                    <span className="absolute left-0 top-[0.5em] h-1.5 w-1.5 rounded-full bg-amber-500" />
                    <span className="font-medium text-zinc-100">
                      Behavioural surplus
                    </span>
                    , much of what&apos;s captured goes beyond what the immediate
                    service strictly requires, and that excess is what fuels
                    prediction products. Step 2 measures how compressible your
                    trace is, how accurately a first-order Markov chain trained
                    on your past predicts your future.
                  </li>
                  <li className="relative pl-4">
                    <span className="absolute left-0 top-[0.5em] h-1.5 w-1.5 rounded-full bg-rose-500" />
                    <span className="font-medium text-zinc-100">
                      The feedback loop
                    </span>
                    , rendering isn&apos;t one-way. The predictions a system
                    makes about you are used to select what you see next, which
                    shapes your next event, which becomes new training data.
                    Step 3 names the forms that loop takes in your archive.
                  </li>
                </ul>
                <p className="mt-3 text-xs text-zinc-500">
                  Everything runs in your browser. Your archive is never
                  transmitted. All statistical methods (Markov chain + Laplace
                  smoothing, Wilson confidence intervals, bootstrap, lexicon
                  sentiment) are deterministic and versioned; nothing is a
                  black box.
                </p>
                <p className="mt-2 text-xs text-zinc-500">
                  This tool does <em>not</em> recover TikTok&apos;s actual
                  policy, reward function, or ranking formula. It shows the
                  structural form any such system would find in your trace.
                </p>
              </div>
            </details>

            <details
              className="animate-fade-in-up group w-full rounded-xl border border-zinc-800 bg-zinc-950/60 text-left transition hover:border-zinc-700"
              style={{ animationDelay: "900ms" }}
            >
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-zinc-200">
                <span>How do I get my TikTok data?</span>
                <span
                  aria-hidden
                  className="text-xs text-zinc-500 transition group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <div className="border-t border-zinc-800 px-4 py-4 text-sm leading-relaxed text-zinc-300">
                <ol className="list-decimal space-y-1.5 pl-5">
                  <li>Open the TikTok app → Profile.</li>
                  <li>Settings and privacy → Account → Download your data.</li>
                  <li>
                    Choose what to include (broader is better) and pick{" "}
                    <span className="font-mono">JSON</span> if available, TXT
                    also works.
                  </li>
                  <li>Tap Request data; wait for the export (minutes to days).</li>
                  <li>Return to the same screen, download the ZIP, drop it above.</li>
                </ol>
                <a
                  className="mt-3 inline-block text-xs font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-4 hover:text-zinc-200 hover:decoration-zinc-500"
                  href="https://support.tiktok.com/en/account-and-privacy/personalized-ads-and-data/requesting-your-data"
                  target="_blank"
                  rel="noreferrer"
                >
                  TikTok Support: Requesting your data ↗
                </a>
              </div>
            </details>
          </div>
        </div>
      ) : null}

      {/* Dashboard container — only visible once the landing hero has
          been replaced by a loaded archive. Keeps the max-width and
          padding the original layout used. */}
      <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6">
      <section className={isLoaded ? "flex flex-col gap-12" : "grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]"}>
        <div className="flex flex-col gap-6">
          {/* Drop target was here — moved into the landing hero. */}

          {archive ? (
            <div className="flex flex-col gap-6 animate-fade-in-up">
              {view === "surplus" ? (
                <div className="flex flex-col gap-2 border-t-2 border-zinc-900 pt-5 dark:border-zinc-100">
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                    <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
                      Surplus analysis
                    </span>
                    <span>Audit trail</span>
                  </div>
                  <h2 className="text-2xl font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                    The raw extraction, per-row evidence and mitigation
                  </h2>
                  <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                    The per-row audit: how many signals were captured across your archive, how
                    densely, which rows scored high on behavioral surplus, and what harm-
                    reduction steps the tool recommends from that evidence. Every number here is
                    a reproducible function of your disclosed data.
                  </p>
                </div>
              ) : null}

              {view === "surplus" ? (
                <div className="flex flex-wrap gap-3 text-sm text-zinc-700 dark:text-zinc-200">
                  <span className="rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
                    {archive.inventory.length} files in ZIP
                  </span>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
                    {archive.events.length} parsed events (capped)
                  </span>
                </div>
              ) : null}

              {view === "surplus" ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!archive || !density || !mitigation}
                    onClick={onDownloadReport}
                    className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    Download JSON report
                  </button>
                  <p className="self-center text-xs text-zinc-500 dark:text-zinc-400">
                    Includes every parsed row, heuristics, density peaks, and mitigation text.
                    For PDF, print this page from your browser.
                  </p>
                </div>
              ) : null}

              {/* Plain-English headline (surplus overview) */}
              {view === "surplus" && extractionFlow ? (
                <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-white to-zinc-50 p-6 shadow-sm dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900">
                  <p className="text-base leading-relaxed text-zinc-800 dark:text-zinc-200">
                    TikTok received{" "}
                    <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                      {extractionFlow.metrics.totalSignalEvents.toLocaleString()} signals
                    </span>{" "}
                    from you, adding up to{" "}
                    <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                      {extractionFlow.metrics.highDensityMinutes > 0
                        ? `${Math.round(extractionFlow.metrics.highDensityMinutes / 60)} hours`
                        : "brief moments"}
                    </span>{" "}
                    of dense collection time.
                  </p>
                  <p className="mt-3 text-base leading-relaxed text-zinc-800 dark:text-zinc-200">
                    At your most active 10 minutes, you generated{" "}
                    <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                      {extractionFlow.metrics.peakEventsPerMinute} signals every minute
                    </span>
                    . That&apos;s the kind of fast, detailed trace a recommender can learn from.
                  </p>
                </div>
              ) : null}

              {/* Stepper header — chips + progress bar. Only one step's
                  content renders below at a time, so the reader
                  progresses through the argument instead of scrolling
                  past everything at once. */}
              {view === "rendering" ? (
                <div className="sticky top-[4.5rem] z-20 -mx-4 border-b border-zinc-800/60 bg-zinc-950/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/60 sm:-mx-6 sm:px-6">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1 overflow-x-auto">
                      {RENDERING_STEPS.map((s) => {
                        const active = s.id === renderingStep;
                        const past = s.id < renderingStep;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setRenderingStep(s.id as RenderingStepId)}
                            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                              active
                                ? "bg-zinc-100 text-zinc-900"
                                : past
                                  ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                                  : "bg-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                            }`}
                            aria-current={active ? "step" : undefined}
                          >
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                                active
                                  ? "bg-zinc-900 text-zinc-100"
                                  : past
                                    ? "bg-emerald-500 text-zinc-950"
                                    : "border border-zinc-700 text-zinc-500"
                              }`}
                            >
                              {past ? "✓" : s.id}
                            </span>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="hidden shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-500 md:block">
                      {renderingStep} / {RENDERING_STEPS.length}
                    </p>
                  </div>
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-900">
                    <div
                      className="h-full bg-zinc-100 transition-all duration-300"
                      style={{ width: `${(renderingStep / RENDERING_STEPS.length) * 100}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {/* Rendering in action */}
              {view === "rendering" && renderingStep === 1 && showcase ? (() => {
                // Pre-compute counts once so the fate bar and stat chips
                // don't re-filter dimensions four times each render.
                const fate = {
                  captured: showcase.dims.filter((d) => d.status === "captured").length,
                  flattened: showcase.dims.filter((d) => d.status === "flattened").length,
                  inferred: showcase.dims.filter((d) => d.status === "inferred").length,
                  lost: showcase.dims.filter((d) => d.status === "lost").length,
                };
                const fateTotal = showcase.dims.length || 1;
                const fateBarSegments = [
                  { key: "captured", count: fate.captured, label: "kept verbatim", color: "bg-emerald-500 dark:bg-emerald-600" },
                  { key: "flattened", count: fate.flattened, label: "flattened to a number", color: "bg-amber-500 dark:bg-amber-600" },
                  { key: "inferred", count: fate.inferred, label: "inferred downstream", color: "bg-sky-500 dark:bg-sky-600" },
                  { key: "lost", count: fate.lost, label: "never stored", color: "bg-rose-500 dark:bg-rose-600" },
                ];
                const statusMeta = {
                  captured: { chip: "kept", accent: "border-l-emerald-500 dark:border-l-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
                  flattened: { chip: "→ number", accent: "border-l-amber-500 dark:border-l-amber-500", text: "text-amber-700 dark:text-amber-300" },
                  inferred: { chip: "inferred", accent: "border-l-sky-500 dark:border-l-sky-500", text: "text-sky-700 dark:text-sky-300" },
                  lost: { chip: "not stored", accent: "border-l-rose-500 dark:border-l-rose-500", text: "text-rose-700 dark:text-rose-300" },
                } as const;
                return (
                <section className="flex flex-col gap-5 scroll-mt-6">
                  {/* Sub-step 1. Intro framing + archive-level snapshot
                      on one screen. Tells the reader both what the page
                      is about and how much of their archive it came
                      from, so the "one moment" on sub-step 2 is clearly
                      placed in context of the whole. */}
                  {captureSubStep === 1 ? (
                    <div className="flex flex-col gap-4 border-t-2 border-zinc-900 pt-5 dark:border-zinc-100">
                      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
                          Step 1 of 3
                        </span>
                        <span>Capture, raw behaviour becomes signal</span>
                      </div>
                      <h2 className="text-2xl font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                        How your data gets captured
                      </h2>
                      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                        When you use TikTok, your scrolls, taps, pauses, and keystrokes do
                        not just disappear. They are filtered into discrete{" "}
                        <span className="font-medium">signals</span>. Signals are named
                        fields a learning system can read, things like a search query, a
                        timestamp, a watch-complete flag. Each signal is then fed back into
                        the same system that produced it, which is the first stage of the
                        feedback loop this tool will describe in Steps 2 and 3.
                      </p>

                      {/* Archive-level snapshot, now inline with the
                          intro. Same computation as before, richer
                          visual treatment so the numbers read as the
                          headline of this page. */}
                      {(() => {
                        const s = showcase.archiveStats;
                        const withTextPct =
                          s.eventsTotal > 0
                            ? Math.round((s.eventsWithExtractableText / s.eventsTotal) * 100)
                            : 0;
                        const withSentPct =
                          s.eventsWithExtractableText > 0
                            ? Math.round(
                                (s.eventsWithSentimentHits / s.eventsWithExtractableText) *
                                  100,
                              )
                            : 0;
                        const cards: Array<{
                          label: string;
                          value: string;
                          hint: string;
                          tone: string;
                        }> = [
                          {
                            label: "Total events in your archive",
                            value: s.eventsTotal.toLocaleString(),
                            hint: "rows TikTok recorded across every category in your export",
                            tone:
                              "border-indigo-200 bg-indigo-50/70 text-indigo-950 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-50",
                          },
                          {
                            label: "Events with text we can read",
                            value: `${s.eventsWithExtractableText.toLocaleString()} (${withTextPct}%)`,
                            hint: "searches, comments, captions, and the like. Most rows are just flags and IDs.",
                            tone:
                              "border-emerald-200 bg-emerald-50/70 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-50",
                          },
                          {
                            label: "Of those, emotionally loaded",
                            value: `${s.eventsWithSentimentHits.toLocaleString()} (${withSentPct}%)`,
                            hint: "contain at least one word our sentiment lexicon recognised",
                            tone:
                              "border-rose-200 bg-rose-50/70 text-rose-950 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-50",
                          },
                          {
                            label: "Events carrying a raw payload",
                            value: s.eventsWithRawPreview.toLocaleString(),
                            hint: "rows where TikTok stored the original key/value details, not just a label",
                            tone:
                              "border-amber-200 bg-amber-50/70 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-50",
                          },
                        ];
                        return (
                          <>
                            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              Your archive at a glance
                            </p>
                            <div className="grid gap-3 sm:grid-cols-2">
                              {cards.map((c) => (
                                <div
                                  key={c.label}
                                  className={`rounded-xl border p-4 ${c.tone}`}
                                >
                                  <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
                                    {c.label}
                                  </p>
                                  <p className="mt-1 text-3xl font-semibold tabular-nums">
                                    {c.value}
                                  </p>
                                  <p className="mt-1 text-xs leading-relaxed opacity-90">
                                    {c.hint}
                                  </p>
                                </div>
                              ))}
                            </div>
                            <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                              The moment you are about to look at on the next screen is{" "}
                              <span className="font-medium">one</span> of those{" "}
                              {s.eventsTotal.toLocaleString()} rows. It was picked
                              automatically as the strongest text-bearing example in your
                              archive. Every other row is processed by the same pipeline.
                            </p>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}

                  {/* (Archive-level snapshot is now merged into
                      sub-step 1's intro.) */}

                  {/* Sub-step 2 starts here: fate bar, lived moment,
                      dimensions, raw record, sentiment. All under one
                      conditional so the reader sees the full
                      moment-breakdown at once on screen 2. */}

                  {/* Headline fate bar — the single most important takeaway,
                      up top, visual before verbal. Sub-step 3. */}
                  {captureSubStep === 2 ? (
                  <div
                    className="animate-fade-in-up rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
                    style={{ animationDelay: "150ms" }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        What happened to this moment
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {fate.captured + fate.flattened} of {fateTotal} dimensions survived as data ·{" "}
                        <span className="text-rose-600 dark:text-rose-400">{fate.lost} lost</span>
                      </p>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      Engineers call this step <em>feature extraction</em>. It is the
                      point where your interaction with the app (a tap, a search, a watch)
                      is turned into small numbers and labels a ranking system can read,
                      called <em>signals</em>. The list below shows which parts of your
                      moment became signals, which got shrunk into a single number, and
                      which were dropped entirely.
                    </p>
                    {/* Vertical list: one row per category, each with
                        its own labelled bar. Easier for a reader to map
                        category → count than a segmented horizontal bar. */}
                    <ul className="mt-4 flex flex-col gap-2">
                      {fateBarSegments.map((s) => {
                        const pct = fateTotal > 0 ? (s.count / fateTotal) * 100 : 0;
                        return (
                          <li
                            key={s.key}
                            className="flex items-center gap-3 text-xs"
                            aria-label={`${s.count} ${s.label}`}
                          >
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${s.color}`}
                              aria-hidden
                            />
                            <span className="min-w-[160px] text-zinc-700 dark:text-zinc-200">
                              {s.label}
                            </span>
                            <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                              <span
                                className={`absolute inset-y-0 left-0 ${s.color}`}
                                style={{ width: `${pct}%` }}
                              />
                            </span>
                            <span className="w-8 shrink-0 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                              {s.count}
                            </span>
                            <span className="w-10 shrink-0 text-right font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
                              {Math.round(pct)}%
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  ) : null}

                  {/* The lived moment — quote card, no separator afterward
                      (the fate bar above already establishes context). */}
                  {captureSubStep === 2 ? (
                  <figure
                    className="animate-fade-in-up rounded-2xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-900/60 dark:bg-amber-950/30"
                    style={{ animationDelay: "350ms" }}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
                      The lived moment
                    </p>
                    <blockquote className="mt-2 text-lg leading-snug text-zinc-900 dark:text-zinc-100">
                      {showcase.pick.text
                        ? `\u201C${showcase.pick.text}\u201D`
                        : showcase.pick.ev.label}
                    </blockquote>
                    <figcaption className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {formatWhen(showcase.pick.ev.at)} · {showcase.pick.ev.primitive} event ·{" "}
                      <span className="font-mono">{showcase.pick.ev.sourceFile}</span>
                    </figcaption>
                  </figure>
                  ) : null}

                  {/* Dimensions carousel — grouped by status. Order:
                      lost (red), captured (green), flattened (amber),
                      inferred (sky). Empty groups are skipped. One
                      group shows at a time; reader clicks through. */}
                  {captureSubStep === 2 ? (() => {
                    const groupSpec = [
                      {
                        status: "lost" as const,
                        label: "Never stored",
                        sub: "These parts of your moment have no field in the export. The platform doesn't record them, so they can't be used later.",
                        chipClass: "bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100",
                        borderClass: "border-l-rose-500 dark:border-l-rose-500",
                        pagerActive: "bg-rose-500 dark:bg-rose-400",
                      },
                      {
                        status: "captured" as const,
                        label: "Kept word for word",
                        sub: "Saved exactly, ready to become a feature or a lookup key.",
                        chipClass: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
                        borderClass: "border-l-emerald-500 dark:border-l-emerald-500",
                        pagerActive: "bg-emerald-500 dark:bg-emerald-400",
                      },
                      {
                        status: "flattened" as const,
                        label: "Turned into a number",
                        sub: "Compressed down to a score a ranking model can weight, everything else thrown away.",
                        chipClass: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
                        borderClass: "border-l-amber-500 dark:border-l-amber-500",
                        pagerActive: "bg-amber-500 dark:bg-amber-400",
                      },
                      {
                        status: "inferred" as const,
                        label: "Inferred from nearby rows",
                        sub: "Not saved directly, but the trail around this row makes the answer easy to guess.",
                        chipClass: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100",
                        borderClass: "border-l-sky-500 dark:border-l-sky-500",
                        pagerActive: "bg-sky-500 dark:bg-sky-400",
                      },
                    ];
                    const groups = groupSpec
                      .map((g) => ({
                        ...g,
                        dims: showcase.dims.filter((d) => d.status === g.status),
                      }))
                      .filter((g) => g.dims.length > 0);
                    if (groups.length === 0) return null;
                    const safeIdx = Math.min(
                      dimensionGroupIndex,
                      groups.length - 1,
                    );
                    const current = groups[safeIdx]!;
                    return (
                      <div
                        className="animate-fade-in-up flex flex-col gap-3"
                        style={{ animationDelay: "550ms" }}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Each part of the moment, grouped by what happened to it
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            group {safeIdx + 1} of {groups.length}
                          </p>
                        </div>

                        <div
                          className={`rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 border-l-4 ${current.borderClass}`}
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
                              {current.label}
                            </p>
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${current.chipClass}`}
                            >
                              {current.dims.length} of {showcase.dims.length}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                            {current.sub}
                          </p>
                          <ul className="mt-4 flex flex-col gap-2">
                            {current.dims.map((d, i) => (
                              <li
                                key={i}
                                className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
                              >
                                <p
                                  className={`text-sm font-medium leading-snug ${
                                    d.status === "lost"
                                      ? "text-zinc-500 line-through decoration-rose-400/70 dark:text-zinc-400"
                                      : "text-zinc-900 dark:text-zinc-100"
                                  }`}
                                >
                                  {d.aspect}
                                </p>
                                {d.renderedAs ? (
                                  <code className="mt-2 block break-all rounded-md bg-white px-2 py-1 font-mono text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                                    {d.renderedAs}
                                  </code>
                                ) : null}
                                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                                  {d.note}
                                </p>
                              </li>
                            ))}
                          </ul>

                          <div className="mt-5 flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setDimensionGroupIndex(Math.max(0, safeIdx - 1))
                              }
                              disabled={safeIdx === 0}
                              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <span aria-hidden>←</span>
                              Previous group
                            </button>
                            <div className="flex gap-1.5" aria-hidden>
                              {groups.map((g, i) => (
                                <span
                                  key={g.status}
                                  className={`h-1.5 w-6 rounded-full transition ${
                                    i === safeIdx
                                      ? g.pagerActive
                                      : "bg-zinc-300 dark:bg-zinc-700"
                                  }`}
                                />
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setDimensionGroupIndex(
                                  Math.min(groups.length - 1, safeIdx + 1),
                                )
                              }
                              disabled={safeIdx >= groups.length - 1}
                              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                            >
                              Next group
                              <span aria-hidden>→</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })() : null}

                  {/* Raw record — the exact key/value fields TikTok's
                      export produced for this event. This is what the
                      dimensions list above is categorising. Monospace +
                      schema-style layout; reads as a dump of the row. */}
                  {captureSubStep === 2 && showcase.pick.parsedFields && showcase.pick.parsedFields.length > 0 ? (
                    <div className="rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                      <div className="border-b border-zinc-200 bg-zinc-50/60 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Raw record TikTok stored
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            source: {showcase.pick.ev.sourceFile}
                            {showcase.pick.ev.jsonPath ? ` · ${showcase.pick.ev.jsonPath}` : ""}
                          </p>
                        </div>
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                          {showcase.pick.parsedFields.length} disclosed field
                          {showcase.pick.parsedFields.length === 1 ? "" : "s"} · parsed from the
                          export&apos;s{" "}
                          <span className="font-mono">rawPreview</span> payload
                        </p>
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0 px-4 py-3 text-xs">
                        {showcase.pick.parsedFields.map((f, i) => (
                          <div key={`${f.key}-${i}`} className="contents">
                            <dt className="border-b border-zinc-100 py-1.5 font-mono font-semibold text-zinc-700 dark:border-zinc-900 dark:text-zinc-200">
                              {f.key}
                            </dt>
                            <dd className="break-all border-b border-zinc-100 py-1.5 font-mono text-zinc-900 dark:border-zinc-900 dark:text-zinc-100">
                              {f.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}

                  {/* (The separate "downstream inference scores" panel
                      was merged into "What a model learned" — each
                      bullet now carries both the score value and its
                      definition so the statistic is never disconnected
                      from its meaning.) */}

                  {/* ML flattening step: text → number, shown literally.
                      Condensed — one intro line, a token trail, a single-
                      row derivation, and one takeaway. Shown on sub-step 3. */}
                  {captureSubStep === 2 && showcase.sentiment && showcase.pick.text ? (
                    <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 dark:border-violet-900/60 dark:bg-violet-950/20">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-sm font-semibold text-violet-950 dark:text-violet-100">
                          ML flattening step, text → number
                        </h3>
                        <span className="rounded-full bg-violet-200 px-2 py-0.5 font-mono text-[10px] font-medium text-violet-900 dark:bg-violet-900/60 dark:text-violet-100">
                          {SENTIMENT_MODEL_VERSION}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                        A lexicon-based classifier (AFINN weights · negation flips · intensifier
                        scaling), run locally on your text so you can see the translation.
                      </p>

                      {/* Token trail */}
                      <div className="mt-3 flex flex-wrap gap-1 text-sm leading-loose">
                        {showcase.pick.text.split(/\s+/).filter(Boolean).map((raw, i) => {
                          const lower = raw.toLowerCase().replace(/[^a-z0-9'-]+/g, "");
                          const hit = (showcase.sentiment as SentimentResult).tokens.find(
                            (t) => t.word === lower,
                          );
                          if (!hit) {
                            return (
                              <span key={i} className="text-zinc-500 dark:text-zinc-500">
                                {raw}
                              </span>
                            );
                          }
                          const color =
                            hit.score > 0
                              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
                              : "bg-rose-100 text-rose-900 dark:bg-rose-950/50 dark:text-rose-100";
                          return (
                            <span
                              key={i}
                              className={`rounded px-1.5 py-0.5 font-medium ${color}`}
                              title={`${hit.negated ? "negated · " : ""}intensifier ×${hit.intensifier}`}
                            >
                              {raw}
                              <sub className="ml-1 font-mono text-[10px] opacity-75">
                                {hit.score > 0 ? "+" : ""}
                                {hit.score.toFixed(1)}
                              </sub>
                            </span>
                          );
                        })}
                      </div>

                      {/* Derivation — single line, with arrows for flow */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white/70 px-3 py-2 font-mono text-[11px] text-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-200">
                        <span>Σ = <span className="font-semibold">{showcase.sentiment.score.toFixed(2)}</span></span>
                        <span className="text-zinc-400">→</span>
                        <span>÷ √{showcase.pick.textWordCount} = <span className="font-semibold">{showcase.sentiment.normalized.toFixed(2)}</span></span>
                        <span className="text-zinc-400">→</span>
                        <span>
                          label ={" "}
                          <span
                            className={`font-semibold ${
                              showcase.sentiment.label === "positive"
                                ? "text-emerald-700 dark:text-emerald-300"
                                : showcase.sentiment.label === "negative"
                                  ? "text-rose-700 dark:text-rose-300"
                                  : "text-zinc-700 dark:text-zinc-200"
                            }`}
                          >
                            &quot;{showcase.sentiment.label}&quot;
                          </span>
                        </span>
                      </div>

                      <p className="mt-3 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                        Whatever you meant, a downstream model now sees{" "}
                        <span className="font-mono font-semibold">
                          {showcase.sentiment.normalized.toFixed(2)}
                        </span>
                        . Tone, context, and reason are dropped. <em>That</em> drop is what{" "}
                        &quot;rendering&quot; names.
                      </p>

                      {showcase.sentiment.hits.length === 0 ? (() => {
                        // Contrastive demo: the picked row has no emotion
                        // words. Show the same classifier applied to an
                        // example, so the reader sees rendering happen even
                        // when their own text is neutral.
                        const demoText =
                          "i feel so exhausted and alone tonight, nothing is working";
                        const demoResult = sentimentScore(demoText);
                        return (
                          <div className="mt-4 rounded-xl border border-dashed border-violet-300 bg-white/50 p-3 dark:border-violet-800/70 dark:bg-zinc-950/40">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200">
                              Worked example (your row had no emotion-bearing words)
                            </p>
                            <p className="mt-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                              To show what the classifier does when it lands on emotional
                              language, here&apos;s the same model on a fabricated sentence,
                              the kind of thing a search query or comment might look like:
                            </p>
                            <blockquote className="mt-2 border-l-2 border-violet-300 pl-3 text-sm italic text-zinc-800 dark:border-violet-700 dark:text-zinc-200">
                              &ldquo;{demoText}&rdquo;
                            </blockquote>
                            <div className="mt-2 flex flex-wrap gap-1 text-sm leading-loose">
                              {demoText.split(/\s+/).filter(Boolean).map((raw, i) => {
                                const lower = raw
                                  .toLowerCase()
                                  .replace(/[^a-z0-9'-]+/g, "");
                                const hit = demoResult.tokens.find((t) => t.word === lower);
                                if (!hit) {
                                  return (
                                    <span key={i} className="text-zinc-500 dark:text-zinc-500">
                                      {raw}
                                    </span>
                                  );
                                }
                                const color =
                                  hit.score > 0
                                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
                                    : "bg-rose-100 text-rose-900 dark:bg-rose-950/50 dark:text-rose-100";
                                return (
                                  <span
                                    key={i}
                                    className={`rounded px-1.5 py-0.5 font-medium ${color}`}
                                  >
                                    {raw}
                                    <sub className="ml-1 font-mono text-[10px] opacity-75">
                                      {hit.score > 0 ? "+" : ""}
                                      {hit.score.toFixed(1)}
                                    </sub>
                                  </span>
                                );
                              })}
                            </div>
                            <div className="mt-2 rounded-lg bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-200">
                              sum ={" "}
                              <span className="font-semibold">
                                {demoResult.score.toFixed(2)}
                              </span>{" "}
                              · normalized ={" "}
                              <span className="font-semibold">
                                {demoResult.normalized.toFixed(2)}
                              </span>{" "}
                              · label ={" "}
                              <span className="font-semibold">
                                &quot;{demoResult.label}&quot;
                              </span>
                            </div>
                            <p className="mt-2 text-[11px] italic leading-relaxed text-zinc-600 dark:text-zinc-400">
                              Same weights, same formula, same fate: a paragraph of felt
                              experience compressed to a single signed decimal. Your own row
                              had no words the lexicon recognized, but every row with
                              affective language in your archive goes through exactly this
                              pipeline.
                            </p>
                          </div>
                        );
                      })() : null}
                    </div>
                  ) : null}

                  {/* What the model LEARNED. Final sub-step. No box,
                      no emojis, no visual weight beyond the type itself.
                      A numbered, ruled list so the reader's eye runs
                      cleanly down the page. */}
                  {captureSubStep === 3 ? (
                  <div
                    className="animate-fade-in-up flex flex-col gap-5"
                    style={{ animationDelay: "100ms" }}
                  >
                    <div className="border-b border-zinc-200 pb-3 dark:border-zinc-800">
                      <h3 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
                        One search, and the model has&hellip;
                      </h3>
                    </div>
                    <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                      {(() => {
                        type Learning = {
                          title: string;
                          body: ReactNode;
                          chip?: string;
                        };
                        const learnings: Array<Learning> = [];
                        if (showcase.pick.inf.metrics.identityLinkageScore > 0) {
                          learnings.push({
                            title: "Stitch you across time.",
                            body: (
                              <>
                                Joins this search to every other event in your archive,
                                forming one continuous trainable trajectory. The strength
                                of the account, device, and session identifiers tied to
                                this row is what lets the system rebuild your history
                                after the fact. In plain terms, TikTok can always place
                                this search in the context of what you did before and
                                after.
                              </>
                            ),
                            chip: `identity linkage: ${showcase.pick.inf.metrics.identityLinkageScore} out of 100`,
                          });
                        }
                        if (showcase.pick.ev.at) {
                          learnings.push({
                            title: "Place you in a rhythm.",
                            body: (
                              <>
                                A single timestamp is enough to work out when your session
                                starts and ends, what hour of the day you tend to open the
                                app, and how long it has been since your last event. All
                                three become free inputs to the next ranking call.
                              </>
                            ),
                            chip: `timestamp: ${formatWhen(showcase.pick.ev.at)}`,
                          });
                        }
                        if (showcase.pick.inf.signals.length > 0) {
                          learnings.push({
                            title: "Sort this search into categories.",
                            body: (
                              <>
                                The pipeline flagged{" "}
                                {showcase.pick.inf.signals.length} signal type
                                {showcase.pick.inf.signals.length === 1 ? "" : "s"} for
                                this row (
                                {showcase.pick.inf.signals.slice(0, 3).join(", ")}
                                {showcase.pick.inf.signals.length > 3 ? ", and more" : ""}
                                ). Each one is a label the model already knows how to use.
                                Once a row carries these labels, it can be compared with
                                millions of other rows that share them and ranked the same
                                way.
                              </>
                            ),
                            chip: `signal richness: ${showcase.pick.inf.metrics.signalRichnessScore} out of 100`,
                          });
                        }
                        if (showcase.sentiment && showcase.sentiment.hits.length > 0) {
                          learnings.push({
                            title: "Reduce the words you typed to a single number.",
                            body: (
                              <>
                                The sentiment step in Step 1 compressed the text of the
                                search into one number. From this point on, the model
                                never needs to read your words again. It only needs to
                                match this number to candidate videos whose content scores
                                similarly, and promote those.
                              </>
                            ),
                            chip: `sentiment: ${showcase.sentiment.normalized >= 0 ? "+" : ""}${showcase.sentiment.normalized.toFixed(2)} (${showcase.sentiment.label})`,
                          });
                        }
                        if (showcase.pick.inf.metrics.surplusScore >= 50) {
                          learnings.push({
                            title: "Treat this row as a priority training example.",
                            body: (
                              <>
                                A higher surplus score flags the row as carrying more than
                                the service itself needed. A learner picks those rows more
                                often because they pay back more signal per unit of
                                compute. Your search crossed that bar.
                              </>
                            ),
                            chip: `surplus score: ${showcase.pick.inf.metrics.surplusScore} out of 100, verdict: ${surplusLabel(showcase.pick.inf.surplus.verdict)}`,
                          });
                        }
                        learnings.push({
                          title: "Trust the features it just extracted.",
                          body: (
                            <>
                              The data-quality score says whether the row was complete and
                              parseable enough to use without discounting. This one
                              cleared the bar, so every feature above can be fed to the
                              ranker at face value.
                            </>
                          ),
                          chip: `data quality: ${showcase.pick.inf.metrics.dataQualityScore} out of 100, confidence: ${showcase.pick.inf.confidence}`,
                        });
                        learnings.push({
                          title: "What the model did NOT learn.",
                          body: (
                            <>
                              Your reason for typing this search, your mood, your
                              environment, what you were doing right before opening the
                              app. None of it was stored. None of it can be recovered.
                              The recommender has only the trace you left behind. Zuboff
                              calls this <em>reduction</em>. The model treats the absent
                              dimensions as if they simply did not exist.
                            </>
                          ),
                        });
                        return learnings.map((l, i) => (
                          <li key={i} className="flex gap-4 py-4">
                            <span className="w-5 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-zinc-400">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <div className="flex-1">
                              <p className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
                                {l.title}
                              </p>
                              <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                                {l.body}
                              </p>
                              {l.chip ? (
                                <p className="mt-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                                  {l.chip}
                                </p>
                              ) : null}
                            </div>
                          </li>
                        ));
                      })()}
                    </ol>
                    {/* Scale + framing synthesis — the "so what" every
                        reader needs at this point, plus an honest
                        acknowledgment that TikTok's real model is
                        richer than the one we demo'd. */}
                    <div className="border-t border-zinc-200 pt-5 text-sm leading-relaxed text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                      <p>
                        <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                          All of that, from one search.
                        </span>{" "}
                        Every item in the list above came from a single row in your
                        archive. Now multiply by the{" "}
                        <span className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">
                          {showcase.archiveStats.eventsTotal.toLocaleString()}
                        </span>{" "}
                        other events in your export, then by the many users a platform
                        has at any moment. That scale is what Zuboff means by{" "}
                        <em>rendering</em>. It is the concrete, repeated translation of
                        ordinary behaviour into a trainable dataset. The point isn&apos;t
                        that this one row is harmful. It is that the aggregate is what
                        the feed is optimised against.
                      </p>
                      <p className="mt-3 text-zinc-500 dark:text-zinc-400">
                        <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                          A fair note on the model shown here.
                        </span>{" "}
                        TikTok&apos;s own recommender is almost certainly more complex
                        than what you just watched. Richer representations of your state,
                        learned embeddings instead of hand-coded lexicons, probably far
                        more features per row. What this tool demonstrates is a careful,
                        auditable approximation of the same pattern, built only from your
                        disclosed data and open-source building blocks. The shape of the
                        argument does not change at larger scale. Only the precision does.
                      </p>
                      <p className="mt-3 text-zinc-500 dark:text-zinc-400">
                        Step 2 asks the next honest question. Given many rows like this,
                        how accurately can a learning system predict what you will do
                        next?
                      </p>
                    </div>
                  </div>
                  ) : null}

                  {/* Sub-step arrow: advances within Step 1 until the
                      last sub-step, then is replaced by the outer
                      stepper's Next button. Always centred below the
                      current sub-step content. */}
                  <div className="flex flex-col items-center gap-2 pb-2 pt-4">
                    <button
                      type="button"
                      onClick={() => {
                        if (captureSubStep < 3) {
                          setCaptureSubStep((captureSubStep + 1) as 1 | 2 | 3);
                          return;
                        }
                        setRenderingStep(2);
                        setCaptureSubStep(1);
                      }}
                      className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-5 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      {captureSubStep === 1
                        ? "Zoom in on one moment"
                        : captureSubStep === 2
                          ? "What did the model learn?"
                          : "Continue to Step 2, Prediction"}
                      <span aria-hidden className="text-lg leading-none">
                        →
                      </span>
                    </button>
                    {captureSubStep > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCaptureSubStep((captureSubStep - 1) as 1 | 2 | 3)
                        }
                        className="text-xs text-zinc-400 underline-offset-4 transition hover:text-zinc-200 hover:underline"
                      >
                        back to sub-step {captureSubStep - 1}
                      </button>
                    ) : null}
                    <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                      Sub-step {captureSubStep} of 3 in Capture
                    </p>
                  </div>

                  {captureSubStep === 3 ? (
                    <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      Picked automatically: the event with the richest natural-language
                      content. Every other event in your export undergoes a translation of
                      the same shape. Step 2 shows what a model can do with millions of
                      these rows.
                    </p>
                  ) : null}
                </section>
                );
              })() : null}

              {/* STEP 2 — How easily a model predicts you. The same trace
                  is re-framed as an observational RL dataset so the reader
                  can see the loop as a *compressible* object: the lower
                  the entropy, the cheaper the prediction, the tighter the
                  feedback loop Step 3 will then describe. */}
              {view === "rendering" && renderingStep === 2 && rlTrace && rlTrace.totalTransitions > 0 ? (() => {
                const entropyRatio =
                  rlTrace.uniformBaselineEntropy > 0
                    ? rlTrace.meanPolicyEntropy / rlTrace.uniformBaselineEntropy
                    : 0;
                const entropyReduction = 1 - entropyRatio; // 0 = uniform, 1 = deterministic
                const heldOutPct = Math.round(rlTrace.heldOutAccuracy * 100);
                const heldOutLoPct = Math.round(rlTrace.heldOutAccuracyCI[0] * 100);
                const heldOutHiPct = Math.round(rlTrace.heldOutAccuracyCI[1] * 100);
                const inSamplePct = Math.round(rlTrace.inSampleAccuracy * 100);
                const inSampleLoPct = Math.round(rlTrace.inSampleAccuracyCI[0] * 100);
                const inSampleHiPct = Math.round(rlTrace.inSampleAccuracyCI[1] * 100);
                const fitGenGap = inSamplePct - heldOutPct;
                const dq = rlTrace.dataQuality;
                const datedPct = dq.eventsTotal > 0
                  ? Math.round((dq.eventsWithTimestamp / dq.eventsTotal) * 100)
                  : 0;
                const dateRangeDays = (() => {
                  if (!dq.firstEventAt || !dq.lastEventAt) return null;
                  const t0 = Date.parse(dq.firstEventAt);
                  const t1 = Date.parse(dq.lastEventAt);
                  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
                  return Math.max(1, Math.round((t1 - t0) / (1000 * 60 * 60 * 24)));
                })();
                const stateColor: Record<RLState, string> = {
                  attention: "bg-violet-500",
                  preference: "bg-emerald-500",
                  intent: "bg-amber-500",
                  social: "bg-sky-500",
                  account: "bg-rose-500",
                  unknown: "bg-zinc-400",
                };
                const friendly = (s: RLState) => STATE_FRIENDLY_NAME[s];

                // Build a "decision flow" chain: start from the
                // strongest rule's source state, walk forward taking
                // the most likely next transition that hasn't been
                // used yet. The result is a naturally-connected
                // storyline through the reader's own behaviour, not a
                // rank-sorted list. We cap at 5 hops so the carousel
                // doesn't sprawl.
                const chain = (() => {
                  if (!rlTrace.strongestRule) return [] as typeof rlTrace.topTransitions;
                  const byFrom = new Map<
                    RLState,
                    typeof rlTrace.topTransitions
                  >();
                  for (const t of rlTrace.topTransitions) {
                    const arr = byFrom.get(t.from) ?? [];
                    arr.push(t);
                    byFrom.set(t.from, arr);
                  }
                  for (const arr of byFrom.values()) {
                    arr.sort((a, b) => b.probability - a.probability);
                  }
                  const walk: typeof rlTrace.topTransitions = [];
                  const used = new Set<string>();
                  let current: RLState = rlTrace.strongestRule.from;
                  for (let i = 0; i < 5; i++) {
                    const choices = byFrom.get(current) ?? [];
                    const next = choices.find(
                      (t) => !used.has(`${t.from}→${t.to}`),
                    );
                    if (!next) break;
                    walk.push(next);
                    used.add(`${next.from}→${next.to}`);
                    current = next.to;
                  }
                  return walk;
                })();
                const safeChainIndex = Math.min(
                  chainStepIndex,
                  Math.max(0, chain.length - 1),
                );
                const currentChainStep = chain[safeChainIndex];

                return (
                  <section className="flex flex-col gap-5 scroll-mt-6">
                    {/* Chapter header — shared across both sub-steps,
                        rewritten in plain language. */}
                    <div className="flex flex-col gap-2 border-t-2 border-zinc-900 pt-5 dark:border-zinc-100">
                      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
                          Step 2 of 3
                        </span>
                        <span>Prediction, your behaviour as a flow</span>
                      </div>
                      <h2 className="text-2xl font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                        How easily a model can predict you
                      </h2>
                      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                        Step 1 turned your behaviour into signals. Now we ask the
                        obvious next question. Given everything you have done, how
                        reliably can a learning system guess what you will do next?
                      </p>
                    </div>

                    {/* ========== SUB-STEP 1 — decision flow carousel ========== */}
                    {predictionSubStep === 1 && currentChainStep ? (
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Your behaviour, one move at a time
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            link {safeChainIndex + 1} of {chain.length} in the chain
                          </p>
                        </div>
                        <div className="rounded-2xl border border-indigo-300 bg-gradient-to-br from-indigo-50 to-white p-6 dark:border-indigo-800/60 dark:from-indigo-950/40 dark:to-zinc-950">
                          <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-indigo-900/80 dark:text-indigo-200/80">
                            <span className="inline-flex items-center gap-2 rounded-full bg-white/60 px-3 py-1 dark:bg-zinc-950/60">
                              <span
                                className={`h-2 w-2 rounded-full ${stateColor[currentChainStep.from]}`}
                              />
                              After you were{" "}
                              <span className="font-semibold capitalize text-indigo-950 dark:text-indigo-50">
                                {friendly(currentChainStep.from)}
                              </span>
                            </span>
                            <span aria-hidden>→</span>
                            <span className="inline-flex items-center gap-2 rounded-full bg-white/60 px-3 py-1 dark:bg-zinc-950/60">
                              <span
                                className={`h-2 w-2 rounded-full ${stateColor[currentChainStep.to]}`}
                              />
                              the next thing was{" "}
                              <span className="font-semibold capitalize text-indigo-950 dark:text-indigo-50">
                                {friendly(currentChainStep.to)}
                              </span>
                            </span>
                          </div>
                          <p className="mt-4 flex items-baseline gap-3 text-5xl font-semibold tabular-nums text-indigo-950 dark:text-indigo-50">
                            {Math.round(currentChainStep.probability * 100)}%
                            <span className="text-sm font-normal text-indigo-800/80 dark:text-indigo-200/80">
                              of the time
                            </span>
                          </p>
                          <p className="mt-1 text-xs text-indigo-900/70 dark:text-indigo-100/70">
                            across {currentChainStep.count.toLocaleString()} observations in
                            your archive · 95% confidence interval{" "}
                            {Math.round(currentChainStep.probabilityCI[0] * 100)}%–
                            {Math.round(currentChainStep.probabilityCI[1] * 100)}%
                          </p>
                          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-indigo-200/40 dark:bg-indigo-900/40">
                            <div
                              className="h-full rounded-full bg-indigo-600 dark:bg-indigo-400"
                              style={{
                                width: `${Math.round(currentChainStep.probability * 100)}%`,
                              }}
                            />
                          </div>
                          <div className="mt-5 flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setChainStepIndex(Math.max(0, safeChainIndex - 1))
                              }
                              disabled={safeChainIndex === 0}
                              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <span aria-hidden>←</span>
                              Previous link
                            </button>
                            <div className="flex gap-1.5" aria-hidden>
                              {chain.map((_, i) => (
                                <span
                                  key={i}
                                  className={`h-1.5 w-6 rounded-full transition ${
                                    i === safeChainIndex
                                      ? "bg-indigo-600 dark:bg-indigo-400"
                                      : "bg-indigo-200 dark:bg-indigo-900"
                                  }`}
                                />
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setChainStepIndex(
                                  Math.min(chain.length - 1, safeChainIndex + 1),
                                )
                              }
                              disabled={safeChainIndex >= chain.length - 1}
                              className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-indigo-500 dark:text-zinc-950 dark:hover:bg-indigo-400"
                            >
                              Next link
                              <span aria-hidden>→</span>
                            </button>
                          </div>
                        </div>

                        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                          A recommender sees exactly this chain and uses it to guess
                          what to put in front of you next.
                        </p>
                      </div>
                    ) : null}

                    {/* Data-quality strip — what the reader needs to know
                        before trusting any downstream number. Sub-step 1. */}
                    {predictionSubStep === 1 ? (
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/40">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Input quality
                      </p>
                      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-zinc-700 dark:text-zinc-200">
                        <div>
                          <dt className="inline text-zinc-500 dark:text-zinc-400">events:</dt>{" "}
                          <dd className="inline font-semibold">{dq.eventsTotal.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="inline text-zinc-500 dark:text-zinc-400">
                            with timestamp:
                          </dt>{" "}
                          <dd className="inline font-semibold">
                            {dq.eventsWithTimestamp.toLocaleString()} ({datedPct}%)
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-zinc-500 dark:text-zinc-400">
                            in-session bigrams:
                          </dt>{" "}
                          <dd className="inline font-semibold">
                            {dq.bigramsUsable.toLocaleString()}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-zinc-500 dark:text-zinc-400">
                            cross-session dropped:
                          </dt>{" "}
                          <dd className="inline font-semibold">
                            {dq.bigramsDroppedCrossSession.toLocaleString()}
                          </dd>
                        </div>
                        {dateRangeDays !== null ? (
                          <div>
                            <dt className="inline text-zinc-500 dark:text-zinc-400">
                              date span:
                            </dt>{" "}
                            <dd className="inline font-semibold">{dateRangeDays} days</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="inline text-zinc-500 dark:text-zinc-400">
                            held-out size:
                          </dt>{" "}
                          <dd className="inline font-semibold">
                            {rlTrace.heldOutSize.toLocaleString()}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    ) : null}

                    {/* Full top-rules table — now shown BELOW the
                        carousel on sub-step 1, as the "read the full
                        list" reference. Moved up from its old position. */}
                    {predictionSubStep === 1 ? (
                      <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              The full list of your top behaviour rules
                            </p>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              Each row is one transition. &ldquo;After <em>A</em>, you do{" "}
                              <em>B</em>&rdquo; this often. The bar is the probability, the
                              bracket is the 95% confidence interval, and{" "}
                              <span className="font-mono">r̄</span> is a rough engagement
                              proxy (how many events tend to cluster around the next one).
                            </p>
                          </div>
                        </div>
                        <ul className="mt-3 flex flex-col gap-2">
                          {rlTrace.topTransitions.map((t) => (
                            <li
                              key={`${t.from}-${t.to}`}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                            >
                              <span
                                className="flex min-w-[130px] items-center gap-1.5"
                                title={`state: ${t.from}`}
                              >
                                <span
                                  className={`h-2 w-2 rounded-full ${stateColor[t.from]}`}
                                />
                                <span className="text-xs capitalize text-zinc-700 dark:text-zinc-200">
                                  {friendly(t.from)}
                                </span>
                              </span>
                              <span className="text-zinc-400">→</span>
                              <span
                                className="flex min-w-[130px] items-center gap-1.5"
                                title={`action: ${t.to}`}
                              >
                                <span
                                  className={`h-2 w-2 rounded-full ${stateColor[t.to]}`}
                                />
                                <span className="text-xs capitalize text-zinc-700 dark:text-zinc-200">
                                  {friendly(t.to)}
                                </span>
                              </span>
                              <span className="relative ml-2 h-1.5 flex-1 min-w-[80px] overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                                <span
                                  className="absolute inset-y-0 left-0 bg-indigo-500 dark:bg-indigo-400"
                                  style={{
                                    width: `${Math.round(t.probability * 100)}%`,
                                  }}
                                />
                              </span>
                              <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-700 dark:text-zinc-200">
                                {Math.round(t.probability * 100)}%
                              </span>
                              <span className="w-24 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
                                [{Math.round(t.probabilityCI[0] * 100)}–
                                {Math.round(t.probabilityCI[1] * 100)}]
                              </span>
                              <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                                r̄ = {t.meanReward.toFixed(1)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {/* ========== SUB-STEP 2 — combined strengths + weak spots ========== */}
                    {predictionSubStep === 2 ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      {/* Primary: held-out accuracy */}
                      <div className="rounded-2xl border border-indigo-300 bg-indigo-50/80 p-4 dark:border-indigo-800 dark:bg-indigo-950/30 ring-1 ring-indigo-500/20">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
                          How often it guesses right
                        </p>
                        <p className="mt-1 text-3xl font-semibold tabular-nums text-indigo-950 dark:text-indigo-50">
                          {heldOutPct}%
                          <span className="ml-2 text-[11px] font-normal text-indigo-800/80 dark:text-indigo-300/80">
                            range: {heldOutLoPct}–{heldOutHiPct}%
                          </span>
                        </p>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-indigo-200/50 dark:bg-indigo-900/40">
                          <div
                            className="h-full bg-indigo-600 dark:bg-indigo-500"
                            style={{ width: `${heldOutPct}%` }}
                          />
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-indigo-900/90 dark:text-indigo-100/90">
                          Trained on your older behaviour, tested on your newer behaviour.
                          {" "}{heldOutPct} out of every 100 of your next moves were guessed
                          correctly.
                        </p>
                        <details className="group mt-2 border-t border-indigo-200/60 pt-2 dark:border-indigo-900/40">
                          <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/70">
                            How this was computed
                          </summary>
                          <p className="mt-1 font-mono text-[10px] leading-relaxed text-indigo-800/70 dark:text-indigo-300/70">
                            argmax policy from train bigrams · chronological 80/20 split ·
                            percentile bootstrap CI, B=
                            {RL_ESTIMATOR_CONFIG.bootstrapResamples}, over the eval set.
                          </p>
                        </details>
                      </div>

                      {/* Secondary: in-sample fit + overfitting gap */}
                      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/20">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
                          Ceiling check
                        </p>
                        <p className="mt-1 text-3xl font-semibold tabular-nums text-indigo-950 dark:text-indigo-50">
                          {inSamplePct}%
                          <span className="ml-2 text-[11px] font-normal text-indigo-800/80 dark:text-indigo-300/80">
                            range: {inSampleLoPct}–{inSampleHiPct}%
                          </span>
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-indigo-900/90 dark:text-indigo-100/90">
                          Same calculation, but cheating: we let the model see all of your
                          data at once. The difference between this and the number on the
                          left is{" "}
                          <span className="font-semibold">{fitGenGap} points</span>.{" "}
                          {Math.abs(fitGenGap) <= 2
                            ? "A small gap means your behaviour was stable over time."
                            : fitGenGap > 2
                              ? "A positive gap means the model learned some quirks of your past that don't hold up in your future."
                              : "A negative gap means your future behaviour was actually easier to predict than your past."}
                        </p>
                        <details className="group mt-2 border-t border-indigo-200/60 pt-2 dark:border-indigo-900/40">
                          <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/70">
                            How this was computed
                          </summary>
                          <p className="mt-1 font-mono text-[10px] leading-relaxed text-indigo-800/70 dark:text-indigo-300/70">
                            visit-weighted max_a P̂(a|s) ≡ argmax policy fit + eval on the
                            full bigram set.
                          </p>
                        </details>
                      </div>

                      {/* Entropy + perplexity */}
                      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/20">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
                          How many real choices per move
                        </p>
                        <p className="mt-1 flex items-baseline gap-2 text-3xl font-semibold tabular-nums text-indigo-950 dark:text-indigo-50">
                          {Math.pow(2, rlTrace.meanPolicyEntropy).toFixed(1)}
                          <span className="text-xs font-normal text-indigo-800/80 dark:text-indigo-300/80">
                            out of {rlTrace.stateCount}
                          </span>
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-indigo-900/90 dark:text-indigo-100/90">
                          If every next move were equally likely, there would be{" "}
                          <span className="font-semibold">{rlTrace.stateCount}</span>{" "}
                          options. Your actual behaviour narrows that down to about{" "}
                          <span className="font-semibold">
                            {Math.pow(2, rlTrace.meanPolicyEntropy).toFixed(1)}
                          </span>
                          . The smaller this number is, the more predictable you are.
                        </p>
                        <details className="group mt-2 border-t border-indigo-200/60 pt-2 dark:border-indigo-900/40">
                          <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/70">
                            How this was computed
                          </summary>
                          <p className="mt-1 font-mono text-[10px] leading-relaxed text-indigo-800/70 dark:text-indigo-300/70">
                            Visit-weighted Shannon entropy:{" "}
                            {rlTrace.meanPolicyEntropy.toFixed(2)} bits, on the add-α
                            Laplace-smoothed transition matrix, α=
                            {RL_ESTIMATOR_CONFIG.laplaceAlpha}. Perplexity = 2^H ={" "}
                            {Math.pow(2, rlTrace.meanPolicyEntropy).toFixed(2)}. K=
                            {rlTrace.stateCount} observed states.
                          </p>
                        </details>
                      </div>
                    </div>
                    ) : null}

                    {/* Highly-predictable state count — the "rails" banner.
                        Sub-step 2 context. */}
                    {predictionSubStep === 2 ? (
                    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                      <span className="font-semibold">
                        {rlTrace.highlyPredictableStateCount} of {rlTrace.stateCount}
                      </span>{" "}
                      of your main states have one next move that happens more than 90% of
                      the time. Those are the rails a predictor can lean on hardest.
                    </div>
                    ) : null}

                    {/* The strongest rule — the cheapest rule. Sub-step 2. */}
                    {predictionSubStep === 2 && rlTrace.strongestRule ? (
                      <div className="rounded-2xl border border-indigo-300 bg-gradient-to-br from-indigo-50 to-white p-5 dark:border-indigo-800/60 dark:from-indigo-950/30 dark:to-zinc-950">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
                          The cheapest rule the model would learn first
                        </p>
                        <p className="mt-2 text-base leading-relaxed text-zinc-900 dark:text-zinc-100">
                          After you&apos;re{" "}
                          <span className="font-semibold">
                            {friendly(rlTrace.strongestRule.from)}
                          </span>
                          , you almost always{" "}
                          <span className="font-semibold">
                            {friendly(rlTrace.strongestRule.to)}
                          </span>{" "}
                          next, <span className="font-mono">{Math.round(rlTrace.strongestRule.probability * 100)}%</span>{" "}
                          of the time, across{" "}
                          <span className="font-mono">
                            {rlTrace.strongestRule.count.toLocaleString()}
                          </span>{" "}
                          observations.
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                          The chain from data to what you see:{" "}
                          <span className="font-mono text-zinc-800 dark:text-zinc-100">
                            one field
                          </span>{" "}
                          (the source state) →{" "}
                          <span className="font-mono text-zinc-800 dark:text-zinc-100">
                            one prediction
                          </span>{" "}
                          (the most likely next state, with this much confidence) →{" "}
                          <span className="font-mono text-zinc-800 dark:text-zinc-100">
                            one ranking choice
                          </span>{" "}
                          (whichever candidate video best matches that prediction lands at the
                          top of your feed). That&apos;s the machinery, in three steps. At
                          platform scale, the same rule is applied millions of times a
                          second, which is why a single high-confidence rule like this
                          one is economically valuable. It lets the system decide what
                          to show you before it spends any compute on the harder cases.
                        </p>
                        {/* Held-out calibration — does the rule survive
                            on the 20% the model never saw? */}
                        <div className="mt-3 rounded-lg border border-zinc-200 bg-white/60 p-2.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-950/50">
                          <p className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Held-out calibration check
                          </p>
                          {rlTrace.strongestRule.heldOutProbability !== null &&
                          rlTrace.strongestRule.heldOutCI ? (
                            (() => {
                              const trainPct = Math.round(
                                rlTrace.strongestRule.probability * 100,
                              );
                              const testPct = Math.round(
                                rlTrace.strongestRule.heldOutProbability * 100,
                              );
                              const loPct = Math.round(
                                rlTrace.strongestRule.heldOutCI[0] * 100,
                              );
                              const hiPct = Math.round(
                                rlTrace.strongestRule.heldOutCI[1] * 100,
                              );
                              const delta = testPct - trainPct;
                              return (
                                <p className="mt-1 leading-relaxed text-zinc-700 dark:text-zinc-200">
                                  On the held-out 20% of your trace, the same rule held{" "}
                                  <span className="font-semibold">{testPct}%</span> of the time
                                  across{" "}
                                  <span className="font-mono">
                                    {rlTrace.strongestRule.heldOutFromCount.toLocaleString()}
                                  </span>{" "}
                                  observations (Wilson 95% CI{" "}
                                  <span className="font-mono">
                                    {loPct}–{hiPct}%
                                  </span>
                                  ).{" "}
                                  <span
                                    className={
                                      Math.abs(delta) <= 3
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : "text-amber-700 dark:text-amber-300"
                                    }
                                  >
                                    Δ vs. in-sample: {delta >= 0 ? "+" : ""}
                                    {delta} pp
                                  </span>{" "}
                                  {", "}
                                  {Math.abs(delta) <= 3
                                    ? "rule generalises cleanly."
                                    : delta > 3
                                      ? "rule actually STRENGTHENED on the future trace."
                                      : "rule weakened out-of-sample, treat the headline figure as an upper bound."}
                                </p>
                              );
                            })()
                          ) : (
                            <p className="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
                              Insufficient held-out observations of this source state to
                              calibrate (n = {rlTrace.strongestRule.heldOutFromCount}).
                            </p>
                          )}
                        </div>
                        <p className="mt-2 font-mono text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          filtered: transitions with count ≥ 10 only (support guard against
                          spurious 100%-on-N=1 artefacts).
                        </p>
                      </div>
                    ) : null}

                    {/* (Old top-rules table was moved above into sub-step
                        1, beneath the decision-flow carousel.) */}

                    {/* Per-state predictability — sub-step 2. Shows the
                        easiest-to-predict state alongside the hardest,
                        so reader sees both strengths and blind spots. */}
                    {predictionSubStep === 2 ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {rlTrace.mostPredictable ? (
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                            Where the model needs least information
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-lg font-semibold capitalize text-emerald-950 dark:text-emerald-50">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${stateColor[rlTrace.mostPredictable.state]}`}
                            />
                            {friendly(rlTrace.mostPredictable.state)}
                          </p>
                          <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
                            H̃ ={" "}
                            <span className="font-mono">
                              {rlTrace.mostPredictable.entropy.toFixed(2)}
                            </span>{" "}
                            bits (raw{" "}
                            <span className="font-mono">
                              {rlTrace.mostPredictable.entropyRaw.toFixed(2)}
                            </span>
                            ) · n ={" "}
                            <span className="font-mono">
                              {rlTrace.mostPredictable.visitCount.toLocaleString()}
                            </span>
                          </p>
                          {rlTrace.mostPredictable.topNext[0] ? (
                            <p className="mt-2 text-xs leading-relaxed text-emerald-900/90 dark:text-emerald-100/90">
                              <span className="font-semibold">
                                {Math.round(
                                  rlTrace.mostPredictable.topNext[0].probability * 100,
                                )}
                                %
                              </span>{" "}
                              of the time this is followed by{" "}
                              <span className="font-medium">
                                {friendly(rlTrace.mostPredictable.topNext[0].to)}
                              </span>
                              . A learner fits this rule from just a handful of examples.
                            </p>
                          ) : null}
                          <p className="mt-2 border-t border-emerald-200/60 pt-2 font-mono text-[10px] leading-relaxed text-emerald-800/80 dark:border-emerald-900/40 dark:text-emerald-300/80">
                            held-out top-1 acc:{" "}
                            {rlTrace.mostPredictable.heldOutTopNextAccuracy !== null
                              ? `${Math.round(rlTrace.mostPredictable.heldOutTopNextAccuracy * 100)}% on n=${rlTrace.mostPredictable.heldOutFromCount.toLocaleString()}`
                              : `insufficient test observations (n=${rlTrace.mostPredictable.heldOutFromCount})`}
                          </p>
                        </div>
                      ) : null}
                      {rlTrace.leastPredictable &&
                      rlTrace.leastPredictable !== rlTrace.mostPredictable ? (
                        <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4 dark:border-rose-900/50 dark:bg-rose-950/20">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-800 dark:text-rose-300">
                            Where you&apos;re hardest to predict
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-lg font-semibold capitalize text-rose-950 dark:text-rose-50">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${stateColor[rlTrace.leastPredictable.state]}`}
                            />
                            {friendly(rlTrace.leastPredictable.state)}
                          </p>
                          <p className="text-xs text-rose-800/80 dark:text-rose-300/80">
                            H̃ ={" "}
                            <span className="font-mono">
                              {rlTrace.leastPredictable.entropy.toFixed(2)}
                            </span>{" "}
                            bits (raw{" "}
                            <span className="font-mono">
                              {rlTrace.leastPredictable.entropyRaw.toFixed(2)}
                            </span>
                            ) · n ={" "}
                            <span className="font-mono">
                              {rlTrace.leastPredictable.visitCount.toLocaleString()}
                            </span>
                          </p>
                          <p className="mt-2 text-xs leading-relaxed text-rose-900/90 dark:text-rose-100/90">
                            Your next move here is closer to a coin flip. This is
                            the slack a recommender still has room to learn from you
                            on, the frontier of personalisation.
                          </p>
                          <p className="mt-2 border-t border-rose-200/60 pt-2 font-mono text-[10px] leading-relaxed text-rose-800/80 dark:border-rose-900/40 dark:text-rose-300/80">
                            held-out top-1 acc:{" "}
                            {rlTrace.leastPredictable.heldOutTopNextAccuracy !== null
                              ? `${Math.round(rlTrace.leastPredictable.heldOutTopNextAccuracy * 100)}% on n=${rlTrace.leastPredictable.heldOutFromCount.toLocaleString()}`
                              : `insufficient test observations (n=${rlTrace.leastPredictable.heldOutFromCount})`}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    ) : null}

                    {/* Method footer. Sub-step 2 only. */}
                    {predictionSubStep === 2 ? (
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
                      <p>
                        The numbers above are computed with a first-order Markov chain, an
                        MLE estimator with add-one smoothing on state to next-state, across{" "}
                        {rlTrace.stateCount} observed states, with a chronological{" "}
                        {Math.round(RL_ESTIMATOR_CONFIG.trainFraction * 100)}/
                        {Math.round((1 - RL_ESTIMATOR_CONFIG.trainFraction) * 100)}{" "}
                        train/test split. The confidence intervals come from percentile
                        bootstrap on the evaluation set ({RL_ESTIMATOR_CONFIG.bootstrapResamples}{" "}
                        resamples, policy held fixed).{" "}
                        <span className="font-mono">
                          model: {RL_TRACE_MODEL_VERSION}
                        </span>
                      </p>
                      <p className="mt-2">
                        In plain terms, the model treats each event category as a state and
                        the next event as an action. It learns the most likely next state
                        from your past and asks whether that guess holds up on your future.
                        This does not recover TikTok&apos;s actual ranking formula. Step 3
                        asks what happens when a predictability like this is turned into
                        the rule that chooses your feed.
                      </p>
                    </div>
                    ) : null}

                    {/* Sub-step arrow navigation. */}
                    <div className="flex flex-col items-center gap-2 pt-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (predictionSubStep < 2) {
                            setPredictionSubStep(2);
                            return;
                          }
                          setRenderingStep(3);
                          setPredictionSubStep(1);
                        }}
                        className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-5 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        {predictionSubStep === 1
                          ? "Where the model is strongest, and weakest"
                          : "Continue to Step 3, Loop"}
                        <span aria-hidden className="text-lg leading-none">
                          →
                        </span>
                      </button>
                      {predictionSubStep > 1 ? (
                        <button
                          type="button"
                          onClick={() => setPredictionSubStep(1)}
                          className="text-xs text-zinc-400 underline-offset-4 transition hover:text-zinc-600 hover:underline dark:hover:text-zinc-200"
                        >
                          back to the decision flow
                        </button>
                      ) : null}
                      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        Sub-step {predictionSubStep} of 2 in Prediction
                      </p>
                    </div>
                  </section>
                );
              })() : null}

              {/* STEP 3 — How prediction becomes a loop. Three sub-steps:
                  (1) Your loops, one metric at a time, as a carousel.
                  (2) Your heaviest days, one day at a time.
                  (3) Your shape, the portrait that falls out.
                  Harms have been moved to the Mitigation view so this
                  step stays descriptive; the reader is invited there. */}
              {view === "rendering" && renderingStep === 3 && (loops || patterns) ? (() => {
                // Loops carousel content. Each item is one loops-module metric.
                type LoopCard = {
                  heading: string;
                  headline: string;
                  body: string;
                  impact: ReactNode;
                  tone: "violet" | "sky" | "amber";
                  extraTerms?: Array<{ term: string; distinctDays: number }>;
                };
                const loopCards: Array<LoopCard> = [];
                if (loops) {
                  const cascade = loops.searchToWatchCascade;
                  loopCards.push({
                    heading: "Your search-to-watch cascade",
                    headline: `${cascade.meanFollowUpWatchesPerSearch} watches on average after each search`,
                    body: cascade.plainLanguage,
                    impact: (
                      <>
                        Each search you type hands the ranker roughly{" "}
                        <span className="font-mono font-semibold">
                          {cascade.meanFollowUpWatchesPerSearch}
                        </span>{" "}
                        labelled training examples in the same session. One query in, a
                        cluster of ranked responses to score out.
                      </>
                    ),
                    tone: "violet",
                  });
                  const gap = loops.reEngagementCadence.medianGapHours;
                  loopCards.push({
                    heading: "Your re-engagement cadence",
                    headline:
                      typeof gap === "number"
                        ? `${gap} hours between sessions, on median`
                        : "Cadence not computable from your trace",
                    body: loops.reEngagementCadence.plainLanguage,
                    impact:
                      typeof gap === "number" && gap > 0 ? (
                        <>
                          That works out to roughly{" "}
                          <span className="font-mono font-semibold">
                            {Math.round((7 * 24) / gap)}
                          </span>{" "}
                          opportunities a week for the system to refresh its guess about
                          you. Short cadence means it can track your drift in near-real
                          time, not assume it.
                        </>
                      ) : (
                        <>Too little temporal signal to read cadence meaningfully.</>
                      ),
                    tone: "sky",
                  });
                  loopCards.push({
                    heading: "Your returning interests",
                    headline: `${Math.round(loops.returningInterests.returningInterestRate * 100)}% of your distinct searches came back another day`,
                    body: loops.returningInterests.plainLanguage,
                    impact: (
                      <>
                        These recurrences are the stable interest clusters a recommender
                        can bet on safely. The higher the rate, the more the feed leans
                        on familiar topics over novel ones.
                      </>
                    ),
                    tone: "amber",
                    extraTerms: loops.returningInterests.topReturningTerms.slice(0, 5),
                  });
                }
                const safeLoopIndex = Math.min(
                  loopMetricIndex,
                  Math.max(0, loopCards.length - 1),
                ) as 0 | 1 | 2;
                const currentLoopCard = loopCards[safeLoopIndex];
                const loopTone = (t: "violet" | "sky" | "amber") =>
                  t === "violet"
                    ? {
                        border: "border-violet-300 dark:border-violet-800/60",
                        bg: "from-violet-50 to-white dark:from-violet-950/40 dark:to-zinc-950",
                        pillBg: "bg-white/60 dark:bg-zinc-950/60",
                        accent: "text-violet-900 dark:text-violet-100",
                        dot: "bg-violet-500 dark:bg-violet-400",
                      }
                    : t === "sky"
                      ? {
                          border: "border-sky-300 dark:border-sky-800/60",
                          bg: "from-sky-50 to-white dark:from-sky-950/40 dark:to-zinc-950",
                          pillBg: "bg-white/60 dark:bg-zinc-950/60",
                          accent: "text-sky-900 dark:text-sky-100",
                          dot: "bg-sky-500 dark:bg-sky-400",
                        }
                      : {
                          border: "border-amber-300 dark:border-amber-800/60",
                          bg: "from-amber-50 to-white dark:from-amber-950/40 dark:to-zinc-950",
                          pillBg: "bg-white/60 dark:bg-zinc-950/60",
                          accent: "text-amber-900 dark:text-amber-100",
                          dot: "bg-amber-500 dark:bg-amber-400",
                        };

                // Heaviest-days carousel content.
                const binges = patterns?.bingeDays ?? [];
                const medianDaily = patterns
                  ? Math.max(1, (patterns as { medianDailyEvents?: number }).medianDailyEvents ?? 1)
                  : 1;
                const safeBingeIndex = Math.min(
                  bingeDayIndex,
                  Math.max(0, binges.length - 1),
                );
                const currentBinge = binges[safeBingeIndex] ?? null;
                const currentBingeMultiple = currentBinge
                  ? Math.round(currentBinge.count / medianDaily)
                  : 0;

                return (
                  <section className="flex flex-col gap-5 scroll-mt-6">
                    {/* Chapter header — shared across all sub-steps */}
                    <div className="flex flex-col gap-2 border-t-2 border-zinc-900 pt-5 dark:border-zinc-100">
                      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
                          Step 3 of 3
                        </span>
                        <span>The loop, your behaviour as a cycle</span>
                      </div>
                      <h2 className="text-2xl font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                        How prediction becomes a loop
                      </h2>
                      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                        Prediction is not passive. Once a system has the rules from
                        Step 2, it uses them to choose what you see next, which
                        produces the next event, which becomes new training data. The
                        loop closes. A loop is a pattern that keeps training itself.
                      </p>
                    </div>

                    {/* ============ SUB-STEP 1: Loops carousel ============ */}
                    {loopSubStep === 1 && currentLoopCard ? (() => {
                      const t = loopTone(currentLoopCard.tone);
                      return (
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Your loops, one at a time
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            {safeLoopIndex + 1} of {loopCards.length}
                          </p>
                        </div>
                        <div
                          className={`rounded-2xl border bg-gradient-to-br p-6 ${t.border} ${t.bg}`}
                        >
                          <p className={`text-[11px] font-semibold uppercase tracking-wide ${t.accent}`}>
                            {currentLoopCard.heading}
                          </p>
                          <p className={`mt-3 text-2xl font-semibold leading-tight ${t.accent}`}>
                            {currentLoopCard.headline}
                          </p>
                          <p className="mt-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                            {currentLoopCard.body}
                          </p>
                          <div
                            className={`mt-4 rounded-lg px-3 py-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200 ${t.pillBg}`}
                          >
                            <p className={`text-[10px] font-semibold uppercase tracking-wide ${t.accent}`}>
                              What the system does with it
                            </p>
                            <p className="mt-1">{currentLoopCard.impact}</p>
                          </div>
                          {currentLoopCard.extraTerms && currentLoopCard.extraTerms.length > 0 ? (
                            <div className="mt-3">
                              <p className={`text-[10px] font-semibold uppercase tracking-wide ${t.accent}`}>
                                Your top recurring queries
                              </p>
                              <ul className="mt-1 space-y-0.5 text-xs">
                                {currentLoopCard.extraTerms.map((x) => (
                                  <li
                                    key={x.term}
                                    className="flex justify-between gap-2 text-zinc-700 dark:text-zinc-200"
                                  >
                                    <span className="truncate">&ldquo;{x.term}&rdquo;</span>
                                    <span className="shrink-0 font-semibold tabular-nums">
                                      {x.distinctDays} days
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          <div className="mt-5 flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setLoopMetricIndex(
                                  Math.max(0, safeLoopIndex - 1) as 0 | 1 | 2,
                                )
                              }
                              disabled={safeLoopIndex === 0}
                              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <span aria-hidden>←</span>
                              Previous loop
                            </button>
                            <div className="flex gap-1.5" aria-hidden>
                              {loopCards.map((_, i) => (
                                <span
                                  key={i}
                                  className={`h-1.5 w-6 rounded-full transition ${
                                    i === safeLoopIndex ? t.dot : "bg-zinc-300 dark:bg-zinc-700"
                                  }`}
                                />
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setLoopMetricIndex(
                                  Math.min(loopCards.length - 1, safeLoopIndex + 1) as 0 | 1 | 2,
                                )
                              }
                              disabled={safeLoopIndex >= loopCards.length - 1}
                              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                            >
                              Next loop
                              <span aria-hidden>→</span>
                            </button>
                          </div>
                        </div>
                      </div>
                      );
                    })() : null}

                    {/* ============ SUB-STEP 2: Heaviest-days carousel ============ */}
                    {loopSubStep === 2 && binges.length > 0 && currentBinge ? (
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Your heaviest days, one at a time
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            {safeBingeIndex + 1} of {binges.length}
                          </p>
                        </div>
                        <p className="max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                          These are the days that cross the top-decile threshold of your
                          own activity. Imagine every person on the platform having their
                          own version of this list, each one producing an avalanche of
                          signal at the same time. That is the fuel a recommender works
                          with.
                        </p>

                        <div className="rounded-2xl border border-fuchsia-300 bg-gradient-to-br from-fuchsia-50 to-white p-6 dark:border-fuchsia-800/60 dark:from-fuchsia-950/40 dark:to-zinc-950">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-fuchsia-900 dark:text-fuchsia-200">
                            {currentBinge.day}
                          </p>
                          <p className="mt-3 flex items-baseline gap-3 text-5xl font-semibold tabular-nums text-fuchsia-950 dark:text-fuchsia-50">
                            {currentBinge.count.toLocaleString()}
                            <span className="text-sm font-normal text-fuchsia-800/80 dark:text-fuchsia-200/80">
                              signals to the system
                            </span>
                          </p>
                          <p className="mt-1 text-xs text-fuchsia-900/70 dark:text-fuchsia-100/70">
                            roughly{" "}
                            <span className="font-mono font-semibold">
                              {currentBingeMultiple}×
                            </span>{" "}
                            a median day in your archive
                          </p>
                          <p className="mt-4 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                            A day like this produced a concentrated record of who you
                            were. Now picture it happening to many people at once.
                            That is the scale at which extraction gets its material.
                          </p>

                          <div className="mt-5 flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setBingeDayIndex(Math.max(0, safeBingeIndex - 1))
                              }
                              disabled={safeBingeIndex === 0}
                              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <span aria-hidden>←</span>
                              Previous day
                            </button>
                            <div className="flex gap-1" aria-hidden>
                              {binges.slice(0, 10).map((_, i) => (
                                <span
                                  key={i}
                                  className={`h-1.5 w-4 rounded-full transition ${
                                    i === safeBingeIndex
                                      ? "bg-fuchsia-500 dark:bg-fuchsia-400"
                                      : "bg-fuchsia-200 dark:bg-fuchsia-900"
                                  }`}
                                />
                              ))}
                              {binges.length > 10 ? (
                                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                  + more
                                </span>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setBingeDayIndex(
                                  Math.min(binges.length - 1, safeBingeIndex + 1),
                                )
                              }
                              disabled={safeBingeIndex >= binges.length - 1}
                              className="inline-flex items-center gap-1.5 rounded-full bg-fuchsia-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-fuchsia-500 dark:text-zinc-950 dark:hover:bg-fuchsia-400"
                            >
                              Next day
                              <span aria-hidden>→</span>
                            </button>
                          </div>
                        </div>
                        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                          {patterns?.plainLanguage?.bingeDays}
                        </p>
                      </div>
                    ) : loopSubStep === 2 ? (
                      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-5 text-sm leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
                        No day in your archive crossed the heaviest-day threshold. That
                        usually means the use is spread evenly rather than concentrated
                        in peaks.
                      </div>
                    ) : null}

                    {/* ============ SUB-STEP 3: Your shape ============ */}
                    {loopSubStep === 3 && patterns ? (
                      <div className="flex flex-col gap-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          Your shape
                        </p>
                        <p className="max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                          Your hours, your cadence, your return topics. How your life
                          shows up in the feed&apos;s training data.
                        </p>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              When you scroll
                            </p>
                            <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                              {patterns.plainLanguage.rhythm}
                            </p>
                            {(() => {
                              const maxH = patterns.hourOfDay.reduce((m, h) => Math.max(m, h.count), 1);
                              return (
                                <div className="mt-3">
                                  <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                    Hour of day
                                  </p>
                                  <div className="mt-1 flex h-16 items-end gap-[2px]">
                                    {patterns.hourOfDay.map((h) => {
                                      const isPeak = patterns.peakHour?.hour === h.hour;
                                      const heightPct = maxH ? (h.count / maxH) * 100 : 0;
                                      return (
                                        <div
                                          key={h.hour}
                                          className={`flex-1 rounded-sm ${
                                            isPeak
                                              ? "bg-fuchsia-500 dark:bg-fuchsia-400"
                                              : "bg-zinc-300 dark:bg-zinc-700"
                                          }`}
                                          style={{ height: `${heightPct}%` }}
                                          title={`${h.label}: ${h.count.toLocaleString()} events`}
                                        />
                                      );
                                    })}
                                  </div>
                                  <div className="mt-0.5 flex justify-between text-[10px] text-zinc-500 dark:text-zinc-400">
                                    <span>12am</span>
                                    <span>6am</span>
                                    <span>12pm</span>
                                    <span>6pm</span>
                                    <span>12am</span>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>

                          {(() => {
                            const sp = patterns.sessionProfile;
                            const rows = [
                              {
                                key: "quick",
                                label: "Quick checks",
                                range: `under ${SESSION_BUCKETS.quickCheckMaxMinutes} min`,
                                count: sp.quickCheckCount,
                                share: sp.quickCheckTimeShare,
                                bar: "bg-emerald-400 dark:bg-emerald-500",
                                swatch: "bg-emerald-400",
                                text: "text-emerald-700 dark:text-emerald-300",
                              },
                              {
                                key: "typical",
                                label: "Typical scrolls",
                                range: `${SESSION_BUCKETS.quickCheckMaxMinutes} to ${SESSION_BUCKETS.typicalScrollMaxMinutes} min`,
                                count: sp.typicalScrollCount,
                                share: sp.typicalScrollTimeShare,
                                bar: "bg-sky-400 dark:bg-sky-500",
                                swatch: "bg-sky-400",
                                text: "text-sky-700 dark:text-sky-300",
                              },
                              {
                                key: "binge",
                                label: "Binges",
                                range: `over ${SESSION_BUCKETS.typicalScrollMaxMinutes} min`,
                                count: sp.bingeCount,
                                share: sp.bingeTimeShare,
                                bar: "bg-fuchsia-500",
                                swatch: "bg-fuchsia-500",
                                text: "text-fuchsia-700 dark:text-fuchsia-300",
                              },
                            ];
                            return (
                              <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                  How long you scroll
                                </p>
                                <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                                  {patterns.plainLanguage.sessions}
                                </p>

                                <p className="mt-4 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                  Share of your total TikTok time
                                </p>
                                <div className="mt-1 flex h-6 w-full overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                                  {rows.map((r) => (
                                    <div
                                      key={r.key}
                                      className={r.bar}
                                      style={{ width: `${r.share * 100}%` }}
                                      aria-label={`${r.label}: ${Math.round(r.share * 100)}% of time`}
                                    />
                                  ))}
                                </div>

                                <ol className="mt-4 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
                                  {rows.map((r, i) => (
                                    <li
                                      key={r.key}
                                      className="flex items-center gap-3 py-2"
                                    >
                                      <span className="w-4 shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                                        {i + 1}
                                      </span>
                                      <span
                                        className={`h-2.5 w-2.5 shrink-0 rounded-sm ${r.swatch}`}
                                        aria-hidden
                                      />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                          {r.label}
                                        </p>
                                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                          {r.range}
                                        </p>
                                      </div>
                                      <div className="text-right">
                                        <p
                                          className={`text-lg font-semibold tabular-nums ${r.text}`}
                                        >
                                          {Math.round(r.share * 100)}%
                                        </p>
                                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                          {r.count.toLocaleString()}{" "}
                                          session{r.count === 1 ? "" : "s"}
                                        </p>
                                      </div>
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            );
                          })()}

                          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 md:col-span-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              What you keep coming back to
                            </p>
                            <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                              {patterns.plainLanguage.searches}
                            </p>
                            {patterns.recurringSearchThemes.length > 0 ? (
                              <ul className="mt-3 flex flex-wrap gap-2">
                                {patterns.recurringSearchThemes.map((t) => (
                                  <li
                                    key={t.term}
                                    className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                                  >
                                    {t.term}{" "}
                                    <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                                      × {t.count}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        </div>

                        {/* Gateway to Mitigation view — a plain button. */}
                        <button
                          type="button"
                          onClick={() => setView("mitigation")}
                          className="inline-flex w-fit items-center gap-2 rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                        >
                          Open the Mitigation page
                          <span aria-hidden className="text-lg leading-none">
                            →
                          </span>
                        </button>
                      </div>
                    ) : null}

                    {/* Sub-step arrow navigation */}
                    <div className="flex flex-col items-center gap-2 pt-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (loopSubStep < 3) {
                            setLoopSubStep(
                              (loopSubStep + 1) as 1 | 2 | 3,
                            );
                          }
                        }}
                        disabled={loopSubStep === 3}
                        className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-5 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        {loopSubStep === 1
                          ? "Look at your heaviest days"
                          : loopSubStep === 2
                            ? "See the overall shape"
                            : "End of Step 3"}
                        {loopSubStep < 3 ? (
                          <span aria-hidden className="text-lg leading-none">
                            →
                          </span>
                        ) : null}
                      </button>
                      {loopSubStep > 1 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setLoopSubStep((loopSubStep - 1) as 1 | 2 | 3)
                          }
                          className="text-xs text-zinc-400 underline-offset-4 transition hover:text-zinc-600 hover:underline dark:hover:text-zinc-200"
                        >
                          back to sub-step {loopSubStep - 1}
                        </button>
                      ) : null}
                      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        Sub-step {loopSubStep} of 3 in Loop
                      </p>
                    </div>

                    {/* The former polarization / compulsion / emotional
                        targeting harm cards and the "closed loop"
                        synthesis have been relocated to the Mitigation
                        view, accessible from the sticky-nav view
                        switcher. */}
                  </section>
                );
              })() : null}

              {/* (Old Step 4 "Your stats" header deleted — its content
                  is now Step 3 sub-step 3, "Your shape".) */}


              {/* ========== MITIGATION VIEW ========== */}
              {/* Separate top-level view, selectable from the sticky-nav.
                  Holds the three harm readings (polarization, compulsion,
                  emotional targeting) moved out of Step 3 so that the
                  Rendering story stays descriptive. The framing here is
                  explicit: this page is not a warning, it is a way to
                  recognise your own extraction surface in the numbers
                  Steps 2 and 3 already produced. */}
              {view === "mitigation" && rlTrace && loops && patterns ? (() => {
                const strongestPct = rlTrace.strongestRule
                  ? Math.round(rlTrace.strongestRule.probability * 100)
                  : null;
                const medianGap = loops.reEngagementCadence.medianGapHours;
                const returnRate = Math.round(
                  loops.returningInterests.returningInterestRate * 100,
                );
                const sentimentAvailable = Boolean(
                  showcase && showcase.sentiment && showcase.sentiment.hits.length > 0,
                );
                return (
                  <section className="flex flex-col gap-6 scroll-mt-6">
                    {/* Framing header — non-fearmongering, explicit. */}
                    <div className="flex flex-col gap-3 border-t-2 border-zinc-900 pt-5 dark:border-zinc-100">
                      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
                          Mitigation
                        </span>
                        <span>Your extraction surface, in your numbers</span>
                      </div>
                      <h2 className="text-2xl font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                        Mitigation
                      </h2>
                    </div>

                    {/* Things you can actually do, pulled up to the top
                        and laid out as a horizontally scrollable row of
                        tip cards so the prevention shows BEFORE the
                        three readings. */}
                    {mitigation && mitigation.length ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          Things you can actually do
                        </p>
                        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
                          <ul className="flex snap-x snap-mandatory gap-3 pb-1">
                            {mitigation.map((m) => (
                              <li
                                key={m.title}
                                className="flex w-[320px] shrink-0 snap-start flex-col rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-50 sm:w-[360px]"
                              >
                                <p className="font-semibold text-emerald-950 dark:text-emerald-100">
                                  {m.title}
                                </p>
                                <p className="mt-2 text-xs leading-relaxed text-emerald-900/90 dark:text-emerald-100/90">
                                  {m.body}
                                </p>
                                <div className="mt-auto pt-3 text-[10px] leading-relaxed text-emerald-900/75 dark:text-emerald-100/75">
                                  <p>Evidence: {m.evidenceBasis}</p>
                                  {m.source ? (
                                    <p className="mt-0.5 italic">
                                      Source: {m.source}
                                    </p>
                                  ) : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : null}

                    {/* Reading 1 — Rails. Mitigation sub-step 1. */}
                    {mitigationSubStep === 1 ? (
                    <div className="rounded-2xl border-l-4 border-l-fuchsia-500 border border-fuchsia-200 bg-fuchsia-50/60 p-5 dark:border-fuchsia-900/50 dark:bg-fuchsia-950/20">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-fuchsia-900 dark:text-fuchsia-200">
                          Polarization
                        </p>
                        <p className="text-[10px] uppercase tracking-wide text-fuchsia-700/80 dark:text-fuchsia-300/80">
                          rails in your feed
                        </p>
                      </div>
                      <p className="mt-3 flex items-baseline gap-2 text-4xl font-semibold tabular-nums text-fuchsia-950 dark:text-fuchsia-50">
                        {strongestPct !== null ? `${strongestPct}%` : "—"}
                        <span className="text-sm font-normal text-fuchsia-900/70 dark:text-fuchsia-100/70">
                          your strongest predictable transition
                        </span>
                      </p>
                      <p className="mt-3 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                        When one of your moves leads to the same next move{" "}
                        {strongestPct !== null ? `${strongestPct}%` : "almost all"} of
                        the time, the cheapest thing a ranker can do is serve content
                        that keeps you on that rail. More exposure produces more
                        observations, which raises the model&apos;s confidence in the
                        rule, which means more exposure. A second number from your own
                        trace, independent of the first, is that{" "}
                        <span className="font-mono font-semibold">{returnRate}%</span>{" "}
                        of your distinct searches came back on another day. Returning
                        interests and highly-predictable transitions are two different
                        things, but they compound under the same mechanism.
                      </p>
                      <p className="mt-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                        What this is <em>not</em> saying. It is not saying you
                        are stuck in an echo chamber, or that a specific topic has
                        captured you. It is saying the structural conditions are
                        present for a feed to lean hard on familiarity.
                      </p>
                    </div>
                    ) : null}

                    {/* Reading 2 — Cadence. Mitigation sub-step 2. */}
                    {mitigationSubStep === 2 ? (
                    <div className="rounded-2xl border-l-4 border-l-amber-500 border border-amber-200 bg-amber-50/60 p-5 dark:border-amber-900/50 dark:bg-amber-950/20">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                          Compulsion
                        </p>
                        <p className="text-[10px] uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
                          the cadence of your return
                        </p>
                      </div>
                      <p className="mt-3 flex items-baseline gap-2 text-4xl font-semibold tabular-nums text-amber-950 dark:text-amber-50">
                        {typeof medianGap === "number" ? `${medianGap}h` : "—"}
                        <span className="text-sm font-normal text-amber-900/70 dark:text-amber-100/70">
                          median gap between your sessions
                        </span>
                      </p>
                      <p className="mt-3 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                        Your cadence is the clock a learning system uses to ask, which
                        cues pulled this person back? Notifications, time of day,
                        whatever mood they were in. Every return is a new labelled
                        example of which nudges landed. This is the{" "}
                        <span className="font-mono">cue → action → reward</span> loop
                        that trains habit-forming agents, stated in your own numbers.
                      </p>
                      <p className="mt-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                        What this is <em>not</em> saying. It is not saying you
                        are addicted, or that every short gap is harmful. It is saying
                        the shape of your return pattern is a rich signal a
                        habit-targeting model can train against.
                      </p>
                    </div>
                    ) : null}

                    {/* Reading 3 — Feeling. Mitigation sub-step 3. */}
                    {mitigationSubStep === 3 ? (
                    <div className="rounded-2xl border-l-4 border-l-rose-500 border border-rose-200 bg-rose-50/60 p-5 dark:border-rose-900/50 dark:bg-rose-950/20">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-900 dark:text-rose-200">
                          Emotional targeting
                        </p>
                        <p className="text-[10px] uppercase tracking-wide text-rose-700/80 dark:text-rose-300/80">
                          your words flattened to a number
                        </p>
                      </div>
                      <p className="mt-3 flex items-baseline gap-2 text-4xl font-semibold tabular-nums text-rose-950 dark:text-rose-50">
                        {sentimentAvailable && showcase?.sentiment
                          ? (showcase.sentiment.normalized >= 0 ? "+" : "") +
                            showcase.sentiment.normalized.toFixed(2)
                          : "—"}
                        <span className="text-sm font-normal text-rose-900/70 dark:text-rose-100/70">
                          sentiment score of your most loaded row
                        </span>
                      </p>
                      <p className="mt-3 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                        Step 1&apos;s text-to-number step turned your words into a
                        single scalar. Once that happens, the model never needs to
                        read your text again. Content whose own sentiment score is
                        close to yours is a cheap match. The vocabulary you used, the
                        particular concept you cared about, the reason you were in
                        that mood, are all discarded. What persists is the number.
                      </p>
                      {sentimentAvailable && showcase?.sentiment && showcase.pick.text ? (
                        <div className="mt-3 rounded-lg border border-rose-200/70 bg-white/60 px-3 py-2 text-xs leading-relaxed text-rose-950 dark:border-rose-900/40 dark:bg-zinc-950/50 dark:text-rose-100">
                          <p className="font-semibold text-rose-900 dark:text-rose-200">
                            Example from your archive
                          </p>
                          <p className="mt-1">
                            You typed{" "}
                            <span className="font-mono">
                              &ldquo;
                              {showcase.pick.text.length > 80
                                ? showcase.pick.text.slice(0, 77) + "…"
                                : showcase.pick.text}
                              &rdquo;
                            </span>
                            . The classifier flattened it to{" "}
                            <span className="font-mono font-semibold">
                              {showcase.sentiment.normalized >= 0 ? "+" : ""}
                              {showcase.sentiment.normalized.toFixed(2)}
                            </span>{" "}
                            (&quot;{showcase.sentiment.label}&quot;). From here the
                            model compares that number to the sentiment of every
                            candidate video and picks the match.
                          </p>
                        </div>
                      ) : null}
                      <p className="mt-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                        What this is <em>not</em> saying. It is not saying the
                        system knows how you feel. It is saying the emotional content
                        of what you wrote is compressed into a number, and the system
                        can act on that number at a very large scale.
                      </p>
                    </div>
                    ) : null}

                    {/* (Closing synthesis card removed.) */}

                    {/* Sub-step arrow navigation. */}
                    <div className="flex flex-col items-center gap-2 pt-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (mitigationSubStep < 3) {
                            setMitigationSubStep(
                              (mitigationSubStep + 1) as 1 | 2 | 3,
                            );
                          }
                        }}
                        disabled={mitigationSubStep === 3}
                        className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                      >
                        {mitigationSubStep === 1
                          ? "Compulsion"
                          : mitigationSubStep === 2
                            ? "Emotional targeting"
                            : "End of Mitigation"}
                        {mitigationSubStep < 3 ? (
                          <span aria-hidden className="text-lg leading-none">
                            →
                          </span>
                        ) : null}
                      </button>
                      {mitigationSubStep > 1 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setMitigationSubStep(
                              (mitigationSubStep - 1) as 1 | 2 | 3,
                            )
                          }
                          className="text-xs text-zinc-400 underline-offset-4 transition hover:text-zinc-600 hover:underline dark:hover:text-zinc-200"
                        >
                          back to the previous page
                        </button>
                      ) : null}
                      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        Page {mitigationSubStep} of 3 in Mitigation
                      </p>
                    </div>
                  </section>
                );
              })() : null}

              {/* Stepper footer — Prev / Next. Only rendered in the
                  rendering view; Surplus analysis stays a single scroll. */}
              {view === "rendering" ? (
                <div className="flex items-center justify-between gap-3 border-t border-zinc-800/60 pt-6">
                  <button
                    type="button"
                    onClick={() =>
                      setRenderingStep(
                        (Math.max(1, renderingStep - 1) as RenderingStepId),
                      )
                    }
                    disabled={renderingStep === 1}
                    className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <span aria-hidden>←</span>
                    Previous
                  </button>
                  <p className="hidden text-xs text-zinc-500 sm:block">
                    {renderingStep < RENDERING_STEPS.length
                      ? `Next: ${RENDERING_STEPS[renderingStep]?.title ?? ""}`
                      : "That's the full argument. Open Surplus analysis for the raw audit trail."}
                  </p>
                  {renderingStep < RENDERING_STEPS.length ? (
                    <button
                      type="button"
                      onClick={() =>
                        setRenderingStep(
                          (Math.min(
                            RENDERING_STEPS.length,
                            renderingStep + 1,
                          ) as RenderingStepId),
                        )
                      }
                      className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white"
                    >
                      Next: {RENDERING_STEPS[renderingStep]?.label ?? ""}
                      <span aria-hidden>→</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setView("surplus")}
                      className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white"
                    >
                      Open Surplus analysis
                      <span aria-hidden>→</span>
                    </button>
                  )}
                </div>
              ) : null}

              {/* Technical details — collapsed (surplus view only) */}
              {view === "surplus" ? (
              <details className="rounded-2xl border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Show technical details
                  <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    archive score, density tiers, extraction histogram, method card
                  </span>
                </summary>
                <div className="flex flex-col gap-4 px-4 pb-4">

              {extractionFlow ? (
                <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-white to-zinc-50 p-5 shadow-sm dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Signal-events received by TikTok from you
                      </p>
                      <p className="mt-1 text-4xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                        {extractionFlow.metrics.totalSignalEvents.toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Peak extraction rate
                      </p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {extractionFlow.metrics.peakEventsPerMinute}{" "}
                        <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                          events/min
                        </span>
                      </p>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {extractionFlow.metrics.peakWindowEventCount} in a{" "}
                        {extractionFlow.metrics.peakWindowMinutes}-min window
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        High-density minutes
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {extractionFlow.metrics.highDensityMinutes.toLocaleString()}
                      </p>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Active sessions
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {extractionFlow.metrics.sessionCount.toLocaleString()}
                      </p>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Median session
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {extractionFlow.metrics.medianSessionMinutes}{" "}
                        <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                          min
                        </span>
                      </p>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Longest session
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {extractionFlow.metrics.maxSessionMinutes}{" "}
                        <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                          min
                        </span>
                      </p>
                    </div>
                  </div>

                  {extractionFlow.timeline.length > 1 ? (
                    <div className="mt-5">
                      <div className="flex items-baseline justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          Extraction timeline · events per UTC day
                        </p>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span className="inline-block h-2 w-2 rounded-sm bg-fuchsia-500 align-middle"></span>{" "}
                          high-density day ·{" "}
                          <span className="inline-block h-2 w-2 rounded-sm bg-zinc-400 align-middle"></span>{" "}
                          normal day
                        </p>
                      </div>
                      {(() => {
                        const days = extractionFlow.timeline;
                        const maxCount = days.reduce((m, d) => Math.max(m, d.count), 1);
                        const W = 760;
                        const H = 120;
                        const barW = Math.max(1, W / days.length);
                        return (
                          <svg
                            className="mt-2 w-full"
                            viewBox={`0 0 ${W} ${H}`}
                            preserveAspectRatio="none"
                            role="img"
                            aria-label="Events per UTC day over archive history"
                          >
                            {days.map((d, i) => {
                              const h = (d.count / maxCount) * (H - 16);
                              const isHigh = d.highTierCount > 0;
                              const color = isHigh ? "#c026d3" : "#a1a1aa";
                              return (
                                <rect
                                  key={d.day}
                                  x={i * barW}
                                  y={H - h - 4}
                                  width={Math.max(0.5, barW - 0.4)}
                                  height={h}
                                  fill={color}
                                >
                                  <title>{`${d.day}: ${d.count} events${
                                    d.highTierCount ? `, ${d.highTierCount} in high-density windows` : ""
                                  }`}</title>
                                </rect>
                              );
                            })}
                          </svg>
                        );
                      })()}
                      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                        <span>{extractionFlow.timeline[0].day}</span>
                        <span>
                          peak day:{" "}
                          {
                            extractionFlow.timeline.reduce(
                              (best, d) => (d.count > best.count ? d : best),
                              extractionFlow.timeline[0],
                            ).day
                          }
                          {" · "}
                          {extractionFlow.timeline.reduce(
                            (m, d) => Math.max(m, d.count),
                            0,
                          ).toLocaleString()}{" "}
                          events
                        </span>
                        <span>{extractionFlow.timeline[extractionFlow.timeline.length - 1].day}</span>
                      </div>
                    </div>
                  ) : null}

                  <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-300">
                    <span className="font-semibold">Evidence basis: </span>
                    {extractionFlow.evidenceBasis}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="font-semibold">Claim boundary: </span>
                    {extractionFlow.claimBoundary}
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                    Model {EXTRACTION_FLOW_MODEL_VERSION}. Sessions defined by gaps &gt;{" "}
                    {SESSION_GAP_MINUTES} min.
                  </p>
                </div>
              ) : null}

              {archiveScoreResult ? (
                <div className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm leading-relaxed text-zinc-800 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Archive-level verdict
                    </span>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${archiveVerdictBadge(
                        archiveScoreResult.verdict,
                      )}`}
                    >
                      {archiveVerdictLabel(archiveScoreResult.verdict)}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      score {archiveScoreResult.score}/100 · thresholds: high ≥{" "}
                      {ARCHIVE_THRESHOLDS.highSurplusMin}, moderate ≥ {ARCHIVE_THRESHOLDS.moderateMin}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["Density index", archiveScoreResult.components.densityIndex],
                        ["Attention coverage", archiveScoreResult.components.attentionCoverage],
                        ["Intent coverage", archiveScoreResult.components.intentCoverage],
                        ["Identity presence", archiveScoreResult.components.identityPresence],
                        ["Signal breadth", archiveScoreResult.components.signalBreadth],
                        ["Volume", archiveScoreResult.components.volume],
                      ] as const
                    ).map(([label, val]) => (
                      <div key={label} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
                          <span className="font-semibold text-zinc-900 dark:text-zinc-50">{val}</span>
                        </div>
                        <div className="h-1.5 w-full rounded bg-zinc-100 dark:bg-zinc-800">
                          <div
                            className="h-full rounded bg-zinc-800 dark:bg-zinc-200"
                            style={{ width: `${val}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-300">
                    <span className="font-semibold">Evidence basis: </span>
                    {archiveScoreResult.evidenceBasis}
                  </p>
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="font-semibold">Claim boundary: </span>
                    {archiveScoreResult.claimBoundary}
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                    Model {ARCHIVE_SCORE_MODEL_VERSION}. Complementary to per-row verdicts; no row score
                    is altered by this aggregate reading.
                  </p>
                </div>
              ) : null}

              <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
                <p className="font-semibold text-zinc-900 dark:text-zinc-50">Method card (auditable)</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Model version: {INFERENCE_MODEL_VERSION}</li>
                  <li>Feature ruleset: {FEATURE_EXTRACTION_RULESET_VERSION}</li>
                  <li>
                    Surplus thresholds: likely_surplus ≥ {SURPLUS_THRESHOLDS.likelySurplusMin}, mixed ≥{" "}
                    {SURPLUS_THRESHOLDS.mixedMin}, else unclear
                  </li>
                  <li>
                    Density tiers (trailing{" "}
                    {density?.windowMinutes ?? DENSITY_THRESHOLDS.windowMinutesDefault}-min
                    window):{" "}
                    {density?.thresholdsUsed ? (
                      <>
                        high ≥ {density.thresholdsUsed.high} events, elevated ≥{" "}
                        {density.thresholdsUsed.elevated}, else typical
                        {", "}
                        <span className="font-mono">
                          {density.thresholdsUsed.mode}
                        </span>{" "}
                        cutoffs
                        {density.thresholdsUsed.mode === "adaptive"
                          ? ` (quantiles ${Math.round(
                              DENSITY_THRESHOLDS.highQuantile * 100,
                            )}/${Math.round(
                              DENSITY_THRESHOLDS.elevatedQuantile * 100,
                            )} of this archive's count distribution)`
                          : ` (absolute fallback: fewer than ${DENSITY_THRESHOLDS.adaptiveMinEvents} dated events)`}
                      </>
                    ) : (
                      <>
                        high ≥ {DENSITY_THRESHOLDS.high} events, elevated ≥{" "}
                        {DENSITY_THRESHOLDS.elevated}, else typical
                      </>
                    )}
                  </li>
                  <li>Confidence mapping: mean(data quality, signal richness) with fixed cutoffs.</li>
                  <li>
                    Claim boundary: output reflects evidence in your export row, not hidden TikTok ranking
                    coefficients.
                  </li>
                  <li>
                    Archive-level model: {ARCHIVE_SCORE_MODEL_VERSION}. Thresholds: high ≥{" "}
                    {ARCHIVE_THRESHOLDS.highSurplusMin}, moderate ≥ {ARCHIVE_THRESHOLDS.moderateMin}.
                    Read as aggregate of density, coverage, identity, breadth, volume, never as a
                    per-row override.
                  </li>
                  <li>
                    Reproducibility: same ZIP + same model version = same row-level scores, archive
                    score, and verdicts. The downloadable JSON report embeds the full config snapshot.
                  </li>
                </ul>
              </div>

              {density ? (
                <div className="rounded-2xl border border-fuchsia-200/80 bg-fuchsia-50/60 p-4 text-sm text-fuchsia-950 dark:border-fuchsia-900/50 dark:bg-fuchsia-950/20 dark:text-fuchsia-50">
                  <p className="font-semibold text-fuchsia-950 dark:text-fuchsia-50">
                    Temporal surplus density (trailing {density.windowMinutes}-minute windows)
                  </p>
                  <p className="mt-2 leading-relaxed text-fuchsia-900/90 dark:text-fuchsia-100/90">
                    Dense bursts mean many export-dated events packed into a short clock window. That is
                    especially surplus-friendly: models can learn quickly from rapid micro-signals even
                    when each gesture feels trivial.
                  </p>
                  <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-xl bg-white/80 p-3 dark:bg-zinc-950/60">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-fuchsia-800 dark:text-fuchsia-200">
                        High density rows
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{density.tierCounts.high}</dd>
                    </div>
                    <div className="rounded-xl bg-white/80 p-3 dark:bg-zinc-950/60">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-orange-800 dark:text-orange-200">
                        Elevated
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{density.tierCounts.elevated}</dd>
                    </div>
                    <div className="rounded-xl bg-white/80 p-3 dark:bg-zinc-950/60">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
                        Typical
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{density.tierCounts.normal}</dd>
                    </div>
                    <div className="rounded-xl bg-white/80 p-3 dark:bg-zinc-950/60">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
                        Unknown time
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{density.tierCounts.unknown}</dd>
                    </div>
                  </dl>
                  {density.peakTrailingWindow ? (
                    <p className="mt-3 text-xs leading-relaxed text-fuchsia-900/85 dark:text-fuchsia-100/85">
                      Peak window: <span className="font-medium">{density.peakTrailingWindow.count}</span>{" "}
                      dated events between {formatWhen(density.peakTrailingWindow.startIso)} and{" "}
                      {formatWhen(density.peakTrailingWindow.endIso)}.
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-fuchsia-900/80 dark:text-fuchsia-200/80">
                      No dated events, density needs timestamps from the export.
                    </p>
                  )}
                </div>
              ) : null}

              {surplusTotals ? (
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-100">
                  <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                    Behavioral surplus (heuristic scan of parsed rows)
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                    This counts how many export rows <em>look</em> like surplus substrate versus
                    mixed traces, using only coarse event typing, not a forensic audit of TikTok
                    contracts or data minimization claims.
                  </p>
                  <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                    <div className="rounded-xl bg-white p-3 shadow-sm dark:bg-zinc-950">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-200">
                        Likely surplus
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{surplusTotals.likely_surplus}</dd>
                    </div>
                    <div className="rounded-xl bg-white p-3 shadow-sm dark:bg-zinc-950">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-200">
                        Mixed
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{surplusTotals.mixed}</dd>
                    </div>
                    <div className="rounded-xl bg-white p-3 shadow-sm dark:bg-zinc-950">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Unclear
                      </dt>
                      <dd className="text-2xl font-semibold tabular-nums">{surplusTotals.unclear}</dd>
                    </div>
                  </dl>
                </div>
              ) : null}

                </div>
              </details>
              ) : null}

              {/* (The harm-reduction block was removed from the
                  Mitigation view to keep the page descriptive rather
                  than prescriptive.) */}

              {view === "surplus" && archive.warnings.length ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-50">
                  <p className="font-semibold">Parse notes</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {archive.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {view === "surplus" ? (
              <div className="overflow-x-auto overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
                <table className="min-w-[84rem] divide-y divide-zinc-200 text-left text-sm dark:divide-zinc-800">
                  <thead className="bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300">
                    <tr>
                      <th className="px-3 py-3 sm:px-4">When</th>
                      <th className="px-3 py-3 sm:px-4">Surplus density</th>
                      <th className="px-3 py-3 sm:px-4">Lived act (export)</th>
                      <th className="px-3 py-3 sm:px-4">Operational rendering (feature-based)</th>
                      <th className="px-3 py-3 sm:px-4">Behavioral surplus</th>
                      <th className="px-3 py-3 sm:px-4">Probable tuning</th>
                      <th className="px-3 py-3 sm:px-4">Learning note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-900 dark:bg-zinc-950">
                    {rows.map(({ ev, inf, densityTier, densityCount, densityPercentile, windowMinutes }) => (
                      <tr key={ev.id} className="align-top">
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-600 sm:px-4 dark:text-zinc-400">
                          {formatWhen(ev.at)}
                        </td>
                        <td className="px-3 py-3 sm:px-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${densityBadgeClass(densityTier)}`}
                          >
                            {densityLabel(densityTier)}
                          </span>
                          <p className="mt-2 text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                            {densityTier === "unknown"
                              ? "—"
                              : `${densityCount} events / ${windowMinutes} min`}
                          </p>
                          {densityTier !== "unknown" ? (
                            <p
                              className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400"
                              title="Percentile rank of this row's trailing-window count within the user's own count distribution"
                            >
                              P{densityPercentile}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 sm:px-4">
                          <div className="font-medium text-zinc-900 dark:text-zinc-50">{ev.label}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {ev.sourceFile} · {ev.primitive}
                          </div>
                          <details className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                            <summary className="cursor-pointer select-none">Raw preview</summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-zinc-100 p-2 text-[11px] leading-snug dark:bg-zinc-900">
                              {ev.rawPreview}
                            </pre>
                          </details>
                        </td>
                        <td className="px-3 py-3 sm:px-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${badge(inf.confidence)}`}
                            >
                              {inf.confidence} confidence
                            </span>
                          </div>
                          <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                            {inf.rendering}
                          </p>
                          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                            Surplus {inf.metrics.surplusScore}/100 · data quality{" "}
                            {inf.metrics.dataQualityScore}/100 · richness{" "}
                            {inf.metrics.signalRichnessScore}/100 · linkage{" "}
                            {inf.metrics.identityLinkageScore}/100
                          </p>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {inf.signals.join(", ")}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            Uncertainty: data {inf.uncertainty.dataCompleteness}, signal{" "}
                            {inf.uncertainty.signalStrength}, linkage {inf.uncertainty.linkageStrength},{" "}
                            sensitivity {inf.uncertainty.counterfactualSensitivity ?? "stable"}
                          </p>
                        </td>
                        <td className="px-3 py-3 sm:px-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${surplusBadge(inf.surplus.verdict)}`}
                          >
                            {surplusLabel(inf.surplus.verdict)}
                          </span>
                          <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                            {inf.surplus.rationale}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-sm leading-relaxed text-zinc-700 sm:px-4 dark:text-zinc-200">
                          {inf.loop}
                        </td>
                        <td className="px-3 py-3 sm:px-4">
                          <select
                            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                            value={learningNotes[ev.id] ?? ""}
                            onChange={(e) =>
                              setLearningNotes((prev) => ({ ...prev, [ev.id]: e.target.value }))
                            }
                          >
                            <option value="">No note</option>
                            <option value="felt_upset">I recall feeling upset around this time</option>
                            <option value="felt_stuck">I recall feeling stuck in this topic loop</option>
                            <option value="felt_fine">I recall this feeling fine or neutral</option>
                            <option value="uncertain">I am not sure</option>
                          </select>
                          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                            Your own annotation, recorded only in this browser session. It is never
                            fed back into the scoring above, and this tool does not infer emotional
                            state from traces.
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {archive.events.length > rows.length ? (
                  <p className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-900 dark:bg-zinc-900/50 dark:text-zinc-300">
                    Showing first {rows.length} rows for performance. Increase the cap in code when you
                    add virtualization.
                  </p>
                ) : null}
              </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              After you import an archive, each row walks from a lived trace in the export to an
              operational rendering, a surplus judgment, and the kind of tuning loop that surplus
              typically feeds, stated carefully because the ZIP is incomplete by design.
            </p>
          )}
        </div>

        {!isLoaded ? (
        <aside className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 text-sm leading-relaxed text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
            <p className="font-semibold text-zinc-900 dark:text-zinc-50">Two terms (pedagogical)</p>
            <p className="mt-2">
              <span className="font-medium">Rendering</span> names how a lived gesture becomes a
              stable, operable fact inside someone else&apos;s pipeline (scores, vectors, schedules).
            </p>
            <p className="mt-2">
              <span className="font-medium">Behavioral surplus</span> flags traces that look
              especially useful for prediction beyond the narrow moment of service, heuristically,
              from file paths and event type, not from TikTok&apos;s accounting books.
            </p>
            <p className="mt-2">
              <span className="font-medium">Surplus density</span> counts how many <em>dated</em> export
              rows fall inside a short trailing clock window; bursts are especially good at teaching
              models quickly.
            </p>
          </div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            How to get your TikTok data
          </h2>
          <ol className="list-decimal space-y-3 pl-4">
            <li>Open the TikTok app and go to Profile.</li>
            <li>Open the menu, then Settings and privacy.</li>
            <li>Tap Account → Download your data.</li>
            <li>
              Choose what to include (for this tool, broader is better) and pick{" "}
              <span className="font-medium">JSON</span> if available for richer structure; TXT still
              works for many categories.
            </li>
            <li>Tap Request data and wait until the export is ready (can take from minutes to days).</li>
            <li>Return to the same screen, download the ZIP, and upload it here.</li>
          </ol>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Official guidance lives in TikTok&apos;s help center under requesting your data. Exports
            vary by region; some fields (for example precise per-video dwell time) may be missing
            even when the ZIP is complete.
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            If you are in the EEA/UK, TikTok also documents third-party data portability flows; this
            scaffold only needs the ZIP you can download yourself.
          </p>
          <a
            className="text-sm font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-700 dark:text-zinc-50 dark:decoration-zinc-600 dark:hover:decoration-zinc-300"
            href="https://support.tiktok.com/en/account-and-privacy/personalized-ads-and-data/requesting-your-data"
            target="_blank"
            rel="noreferrer"
          >
            TikTok Support: Requesting your data
          </a>
        </aside>
        ) : null}
      </section>
      </div>
    </div>
  );
}
