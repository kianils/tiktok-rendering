const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { parseTikTokExportZip } = require("./.test-build/parseExport.js");
const { analyzeTemporalDensity } = require("./.test-build/density.js");
const { computePatterns } = require("./.test-build/patterns.js");
const { computeLoops } = require("./.test-build/loops.js");

const ZIP_PATH = resolve(process.cwd(), "data/TikTok_Data_1776731214.zip");
const buf = readFileSync(ZIP_PATH);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const fileLike = { name: "x.zip", size: buf.byteLength, arrayBuffer: async () => ab };

(async () => {
  const parsed = await parseTikTokExportZip(fileLike);
  const density = analyzeTemporalDensity(parsed.events);
  const tP = Date.now();
  const patterns = computePatterns(parsed.events);
  const tPatterns = Date.now() - tP;
  const tL = Date.now();
  const loops = computeLoops(parsed.events, patterns);
  const tLoops = Date.now() - tL;

  const out = {
    timings: { patterns_ms: tPatterns, loops_ms: tLoops },
    patterns: {
      peakHour: patterns.peakHour,
      peakDayOfWeek: patterns.peakDayOfWeek,
      hourHistogram: patterns.hourOfDay,
      dayOfWeek: patterns.dayOfWeek,
      sessionProfile: patterns.sessionProfile,
      recurringSearchThemes: patterns.recurringSearchThemes,
      searchesTotal: patterns.searchesTotal,
      bingeDayCount: patterns.bingeDayCount,
      bingeDays: patterns.bingeDays,
      medianDailyEvents: patterns.medianDailyEvents,
      plainLanguage: patterns.plainLanguage,
    },
    loops: {
      cascade: {
        searchesAnalyzed: loops.searchToWatchCascade.searchesAnalyzed,
        total: loops.searchToWatchCascade.totalFollowUpWatches,
        mean: loops.searchToWatchCascade.meanFollowUpWatchesPerSearch,
        median: loops.searchToWatchCascade.medianFollowUpWatchesPerSearch,
        top: loops.searchToWatchCascade.topCascades,
        plain: loops.searchToWatchCascade.plainLanguage,
      },
      cadence: {
        sessionCount: loops.reEngagementCadence.sessionCount,
        medianGapHours: loops.reEngagementCadence.medianGapHours,
        fastReturnCount: loops.reEngagementCadence.fastReturnCount,
        plain: loops.reEngagementCadence.plainLanguage,
      },
      returning: {
        uniqueTerms: loops.returningInterests.uniqueTermsSearched,
        multiDay: loops.returningInterests.termsSearchedOnMultipleDays,
        rate: loops.returningInterests.returningInterestRate,
        topReturning: loops.returningInterests.topReturningTerms,
        plain: loops.returningInterests.plainLanguage,
      },
    },
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
