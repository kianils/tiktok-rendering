import { DENSITY_THRESHOLDS, type TemporalDensityResult } from "./density";
import { inferRow } from "./infer";
import type { ArchiveEvent, SurplusVerdict } from "./types";

export type MitigationItem = {
  title: string;
  body: string;
  evidenceBasis: string;
  claimBoundary: string;
  /**
   * Optional citation for the intervention or finding that supports
   * this card. Kept short, rendered next to the evidence basis in
   * the UI. Empty string when the card's claim is a straightforward
   * architectural or platform point rather than a study result.
   */
  source?: string;
};

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
export const MITIGATION_GATES = {
  attentionShare: 0.35,
  intentShare: 0.08,
  socialShare: 0.1,
  likelySurplusShare: 0.45,
  densePeakWindowMin: 20,
} as const;

function countSignals(events: ArchiveEvent[]) {
  const m: Record<string, number> = {};
  for (const e of events) {
    const inf = inferRow(e);
    for (const s of inf.signals) m[s] = (m[s] ?? 0) + 1;
  }
  return m;
}

/** Plain-language harm-reduction ideas tied to what the export suggests—no “secret bypass” claims. */
export function buildMitigationAdvice(input: {
  events: ArchiveEvent[];
  surplusTotals: Record<SurplusVerdict, number>;
  density: TemporalDensityResult;
}): MitigationItem[] {
  const items: MitigationItem[] = [];
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
  const peakCrossedSoftGate = peakCount >= MITIGATION_GATES.densePeakWindowMin;
  if (hadHighDensityRow || peakCrossedSoftGate) {
    items.push({
      title: "Cap your daily time in the app",
      body:
        "In a Penn study (Hunt et al. 2018), people who cut social media to 30 minutes a day for three weeks felt less lonely and less depressed, with the biggest drop for those who came in struggling most. Try Settings and privacy → Screen time → Daily screen time. Think of your scrolling like a grocery budget, a number on it makes it stick.",
      evidenceBasis: `Dense stretches in your trace: ${density.tierCounts.high} rows at 'high' density, peak window ${peakCount} events in ${density.windowMinutes} min.`,
      claimBoundary: "Caps exposure, does not change what is shown inside it.",
      source: "Hunt et al., J Soc Clin Psychol 37(10), 2018.",
    });
  }

  if (attentionShare >= MITIGATION_GATES.attentionShare) {
    items.push({
      title: "Refresh your For You feed",
      body:
        "When the feed feels locked in, TikTok gives you a one-tap reset: Settings → Content preferences → Refresh your For You feed. Think of it like turning the pillow over. Same pillow, but the side that was learning your sleep pattern cools down for a bit.",
      evidenceBasis: `Watch or consumption signals on ${Math.round(attentionShare * 100)}% of your rows.`,
      claimBoundary: "Weakens recent state, does not delete your history.",
      source: "TikTok Newsroom, 16 March 2023.",
    });
  }

  if (intentShare >= MITIGATION_GATES.intentShare) {
    items.push({
      title: "Keep private searches private",
      body:
        "Typing something into TikTok search is you telling the feed, in plain words, what is on your mind. For anything about your health, money, relationships, or identity, type it somewhere else. Think of the TikTok search bar like a group chat. Whatever you send becomes material.",
      evidenceBasis: `Text-query intent signals on ${Math.round(intentShare * 100)}% of your rows.`,
      claimBoundary: "Reduces what TikTok learns, not what the other search engine learns.",
    });
  }

  if (socialShare >= MITIGATION_GATES.socialShare) {
    items.push({
      title: "Split your scrolling from your friend list",
      body:
        "A single account carrying both your friends and your browsing gives the feed a richer picture than either alone. A second account, or time blocks that separate the two uses, breaks that graph up. Think of it like not using the same email for work and for dating.",
      evidenceBasis: `Social interaction signals on ${Math.round(socialShare * 100)}% of your rows.`,
      claimBoundary: "Weakens graph-level inference, not per-row inference. Check TikTok's multi-account rules in your region.",
    });
  }

  if (surplusTotals.likely_surplus / n >= MITIGATION_GATES.likelySurplusShare) {
    items.push({
      title: "Download your archive again next quarter",
      body:
        "You did it once for this tool. Do it again in a few months. Settings → Account → Download your data. Think of your archive like bloodwork. One reading is a snapshot. Three readings are a pattern.",
      evidenceBasis: `${Math.round((surplusTotals.likely_surplus / n) * 100)}% of your rows look trainable.`,
      claimBoundary: "Audit practice, not deletion. The export is a copy of what is already on the other side.",
    });
  }

  if (items.length === 0 && n > 0) {
    items.push({
      title: "Turn off push notifications",
      body:
        "Pielot and Rello (2017) asked people to mute push notifications for 24 hours. Self-reported interruption and compulsive checking dropped, and a chunk of participants kept the setting after. Think of push notifications like someone tapping your shoulder every few minutes asking if you are bored.",
      evidenceBasis: "Low signal prevalence with ongoing feed activity in your trace.",
      claimBoundary: "Addresses the cue, not the content behind it.",
      source: "Pielot & Rello. MobileHCI 2017.",
    });
  }

  if (items.length < 5) {
    items.push({
      title: "Know your data rights",
      body:
        "If you live under GDPR (EU, UK) or CCPA (California), you can request deletion of specific data categories through TikTok's official channels. Think of this like returning a library book. It gets the copy off your account. It does not erase the photocopies someone already made.",
      evidenceBasis: "Applies to every archive.",
      claimBoundary: "Platform and legal controls only. Does not reach data already fed into models.",
      source: "GDPR Art. 17; CCPA §1798.105.",
    });
  }

  return items.slice(0, 6);
}
