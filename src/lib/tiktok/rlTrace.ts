import type { ArchiveEvent, RenderPrimitive } from "./types";
import type { TemporalDensityResult } from "./density";

/**
 * Reinforcement-learning view of the archive.
 *
 * Motivation. The paper's central claim is not that behavior is merely
 * recorded, but that rendering is *closed into a loop*: every event becomes
 * a row in the training set that determines the next thing shown to the
 * user. A descriptive-statistics view of the trace (sessions, cadence,
 * rabbit holes) is not enough to make that loop visible. This module
 * reframes the same trace as the canonical RL tuple — (state, action,
 * reward) — which is what any learning system would extract from it.
 *
 * We are NOT claiming to recover TikTok's actual policy, reward function,
 * state encoding, or discount factor. We are claiming a weaker, auditable
 * thing: the trace the user exported has the exact *structural form* that
 * an RL dataset requires. We compute what such a dataset looks like when
 * built deterministically from the disclosed fields. The user can then
 * see the loop — state transitions with probabilities, per-state entropy,
 * a reward-proxy — exactly as a learner would.
 *
 * Abstractions and honesty.
 *
 *   State.    We use the event `primitive` (attention / preference /
 *             intent / social / account / unknown) as the discrete state.
 *             A real recommender would use a much richer embedding, but a
 *             categorical state over disclosed fields is what stays
 *             auditable. The result is a finite-state Markov view — a
 *             simplification the UI must name as such.
 *
 *   Action.   We define "action" as the *primitive of the next event
 *             within the same session*. This is observational — we cannot
 *             see what TikTok chose to show; we only see what the user
 *             interacted with next. In the RL framing this collapses
 *             action and outcome into one, which is the standard
 *             assumption when working from a logged trajectory.
 *
 *   Reward.   We use the density tier of the target event as a reward
 *             proxy: high-density stretches index sustained engagement,
 *             which is what a watch-time-maximizing reward function would
 *             treat as positive return. Again, proxy — not TikTok's
 *             actual reward.
 *
 *   Sessions. Transitions only count when the two events fall inside the
 *             same session (gap < SESSION_GAP_MINUTES). Cross-session
 *             transitions are semantically different (they reflect
 *             re-engagement, not within-episode choice) and are handled
 *             by the separate `loops` module.
 *
 * Output. A transition table with probabilities and rewards, per-state
 * Shannon entropy (in bits) over the next-state distribution, and a
 * summary object naming the most / least predictable states. The UI
 * renders these as "what an RL algorithm would learn from your trace."
 */

export const RL_TRACE_MODEL_VERSION = "observational-rl-v2";

/**
 * Estimator configuration, exposed so the UI and the report can cite
 * exact hyperparameters.
 *
 * - Model: first-order Markov chain over the discrete RenderPrimitive
 *   state space, estimated by maximum likelihood on in-session bigrams.
 * - Smoothing: add-α Laplace smoothing on the (state × next-state)
 *   contingency table before entropy is computed. Chosen so that states
 *   with sparse support (~tens of visits) do not produce artefactually
 *   low or NaN entropy values.
 * - Evaluation: 80/20 chronological train/test split. Fit argmax-policy
 *   on train bigrams, evaluate top-1 accuracy on test bigrams.
 *   Chronological (not random) split matches the temporal-generalization
 *   question we care about — does a model fit on your past predict your
 *   future?
 * - Uncertainty: percentile bootstrap (B = 200) on the evaluation set,
 *   policy held fixed. Gives a 95% CI on accuracy that captures
 *   evaluation-sample variance but not refit variance.
 */
export const RL_ESTIMATOR_CONFIG = Object.freeze({
  model: "first-order Markov chain (MLE + Laplace smoothing)",
  laplaceAlpha: 1,
  trainFraction: 0.8,
  split: "chronological",
  bootstrapResamples: 200,
  bootstrapConfidence: 0.95,
});

/**
 * Plain-language names for primitives. The engineering labels
 * ("attention", "preference") are opaque to a general reader; the UI uses
 * these instead while keeping the engineering label available as a tooltip
 * for technical credibility.
 */
export const STATE_FRIENDLY_NAME: Readonly<Record<RenderPrimitive, string>> = Object.freeze({
  attention: "watching or scrolling",
  preference: "liking or saving",
  intent: "searching",
  social: "following or messaging",
  account: "settings or login",
  unknown: "other activity",
});

/** In-session gap — keep in sync with extractionFlow / patterns. */
export const RL_SESSION_GAP_MINUTES = 30;

export type RLState = RenderPrimitive;

export type RLTransition = {
  from: RLState;
  to: RLState;
  /** Absolute count of this (from, to) pair across all in-session transitions. */
  count: number;
  /** P(to | from), zero when from was never visited. */
  probability: number;
  /**
   * Wilson 95% CI on `probability`, treating the rule as a Bernoulli
   * success rate with k = count (from→to hits) and n = visits(from).
   * Wilson (not normal-approximation) so the interval stays in [0, 1]
   * and handles small / near-0 / near-1 rates without producing bogus
   * negative or >1 bounds.
   */
  probabilityCI: [number, number];
  /**
   * Reward proxy: mean density count of the `to` event. Higher =
   * higher engagement in a time-local window around the target event.
   */
  meanReward: number;
};

export type RLStateStats = {
  state: RLState;
  /** Number of times this state was visited as the source of a transition. */
  visitCount: number;
  /**
   * Shannon entropy (bits) over outgoing transition probabilities,
   * computed AFTER add-α Laplace smoothing. 0 = fully deterministic;
   * log₂(K) = uniform over K observed targets.
   */
  entropy: number;
  /**
   * Unsmoothed entropy (bits). Exposed alongside `entropy` so a reader
   * can see how much smoothing moved the estimate for this state — a
   * sensitivity diagnostic for sparse cells.
   */
  entropyRaw: number;
  /**
   * In-sample top-1 accuracy FOR THIS STATE specifically — the
   * probability of the single most common next state after `state`,
   * over the full bigram set. Equivalent to max_a P̂(a|state) unsmoothed.
   */
  topNextAccuracy: number;
  /**
   * Held-out top-1 accuracy for this state: fit argmax-policy on the
   * train split, evaluate ONLY on test bigrams whose `from == state`.
   * Null when this state never appeared in the test set (or train had
   * no prediction for it).
   */
  heldOutTopNextAccuracy: number | null;
  /** How many test bigrams have `from == state` (denominator for above). */
  heldOutFromCount: number;
  /** Top-3 most frequent next states from this state. */
  topNext: RLTransition[];
};

export type RLTrace = {
  modelVersion: typeof RL_TRACE_MODEL_VERSION;
  totalTransitions: number;
  states: RLStateStats[];
  /** Top-K transitions overall, sorted by count desc. */
  topTransitions: RLTransition[];
  /** Entropy weighted by visit count, in bits per transition. */
  meanPolicyEntropy: number;
  /** Shannon entropy of a uniform policy over observed states — the
   * "no learning" baseline the trace is compared against. */
  uniformBaselineEntropy: number;
  /**
   * In-sample top-1 accuracy — fit argmax-policy on all bigrams, evaluate
   * on the same bigrams. Visit-weighted equivalent of max_a P(a|s).
   * Reported alongside held-out accuracy so a reader can see the fit/
   * generalisation gap directly.
   */
  inSampleAccuracy: number;
  /**
   * 95% percentile-bootstrap CI on inSampleAccuracy, [lo, hi]. Policy is
   * held fixed across resamples; resampling is over evaluation bigrams.
   */
  inSampleAccuracyCI: [number, number];
  /**
   * Held-out top-1 accuracy — fit argmax-policy on the first 80% of
   * bigrams (chronological), evaluate on the last 20%. The honest
   * generalisation number.
   */
  heldOutAccuracy: number;
  /** 95% percentile-bootstrap CI on heldOutAccuracy, [lo, hi]. */
  heldOutAccuracyCI: [number, number];
  /** Number of bigrams in the held-out evaluation set. */
  heldOutSize: number;
  /**
   * Count of states whose single most likely next-action has probability
   * >= 0.9 — shown as "N of your M typical moves are >90% predictable."
   */
  highlyPredictableStateCount: number;
  /** Total number of distinct states seen (equals states.length). */
  stateCount: number;
  /**
   * The single strongest deterministic rule — the recommender's cheapest
   * win. Augmented with a held-out calibration check: on the test 20%,
   * how often did `from` actually transition to `to`?
   */
  strongestRule:
    | (RLTransition & {
        /**
         * Number of times `from` appeared as a source in the held-out
         * test bigrams. Gives the denominator for the calibration check.
         */
        heldOutFromCount: number;
        /**
         * Empirical held-out rate P_test(to | from), or null if `from`
         * never appeared in the test set.
         */
        heldOutProbability: number | null;
        /** Wilson 95% CI on the held-out rate, or null if undefined. */
        heldOutCI: [number, number] | null;
      })
    | null;
  /** State with lowest entropy (most deterministic next action). */
  mostPredictable: RLStateStats | null;
  /** State with highest entropy (least predictable next action). */
  leastPredictable: RLStateStats | null;
  /** State whose average reward proxy is highest. */
  peakRewardState: RLState | null;
  /**
   * Data-quality summary — what fraction of the archive was usable for
   * fitting this model. A data-engineer-legible answer to "how clean is
   * the input?"
   */
  dataQuality: {
    /** Total events in the archive as provided. */
    eventsTotal: number;
    /** Events that had a parseable timestamp and were included in ordering. */
    eventsWithTimestamp: number;
    /** Usable in-session bigrams (what the model actually trains on). */
    bigramsUsable: number;
    /** Bigrams dropped because the gap exceeded SESSION_GAP_MINUTES. */
    bigramsDroppedCrossSession: number;
    /** ISO timestamp of the earliest dated event. */
    firstEventAt: string | null;
    /** ISO timestamp of the latest dated event. */
    lastEventAt: string | null;
  };
  /** Human-facing summary sentence. */
  plainLanguage: string;
};

const ALL_STATES: RLState[] = [
  "attention",
  "preference",
  "intent",
  "social",
  "account",
  "unknown",
];

function entropyBits(probabilities: number[]): number {
  let h = 0;
  for (const p of probabilities) {
    if (p <= 0) continue;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Wilson 95% CI for a Bernoulli success rate.
 *
 *   center = (k + z²/2) / (n + z²)
 *   half-width = z · √(k(n-k)/n + z²/4) / (n + z²)
 *
 * Preferred over normal-approximation Wald for small n and for rates
 * near 0 or 1 (Wald famously produces intervals that escape [0, 1]).
 * With z = 1.96 for 95% confidence.
 */
function wilsonCI95(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 0];
  const z = 1.96;
  const zSq = z * z;
  const denom = n + zSq;
  const center = (k + zSq / 2) / denom;
  const inner = (k * (n - k)) / n + zSq / 4;
  const half = (z * Math.sqrt(Math.max(0, inner))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

type Bigram = { from: RLState; to: RLState; reward: number };

/**
 * Fit an argmax policy from a set of bigrams: for each source state,
 * return the most frequent next state observed in those bigrams.
 * Falls back to the globally most-frequent next state when a source
 * state is unseen in the fit data. Used for both the full-data policy
 * and the train-only (held-out evaluation) policy.
 */
function fitArgmaxPolicy(bigrams: Bigram[]): {
  policy: Map<RLState, RLState>;
  fallback: RLState | null;
} {
  const pairCounts = new Map<string, number>();
  const toCounts = new Map<RLState, number>();
  for (const bg of bigrams) {
    const k = `${bg.from}→${bg.to}`;
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
    toCounts.set(bg.to, (toCounts.get(bg.to) ?? 0) + 1);
  }
  const policy = new Map<RLState, RLState>();
  for (const state of ALL_STATES) {
    let bestTo: RLState | null = null;
    let bestCount = 0;
    for (const to of ALL_STATES) {
      const c = pairCounts.get(`${state}→${to}`) ?? 0;
      if (c > bestCount) {
        bestCount = c;
        bestTo = to;
      }
    }
    if (bestTo) policy.set(state, bestTo);
  }
  let fallback: RLState | null = null;
  let fallbackCount = 0;
  for (const [s, c] of toCounts) {
    if (c > fallbackCount) {
      fallbackCount = c;
      fallback = s;
    }
  }
  return { policy, fallback };
}

/**
 * Evaluate a fixed argmax policy on a set of bigrams and return the
 * top-1 accuracy (fraction of bigrams whose `to` matches the policy's
 * prediction for `from`). Pure function — used for both point estimate
 * and bootstrap resampling.
 */
function evalAccuracy(
  policy: Map<RLState, RLState>,
  fallback: RLState | null,
  bigrams: Bigram[],
): number {
  if (bigrams.length === 0) return 0;
  let correct = 0;
  for (const bg of bigrams) {
    const pred = policy.get(bg.from) ?? fallback;
    if (pred === bg.to) correct += 1;
  }
  return correct / bigrams.length;
}

/**
 * Percentile-bootstrap 95% CI on top-1 accuracy. Policy is held fixed
 * across resamples; we resample with replacement from the evaluation
 * set only. Captures evaluation-sample variance; NOT refit variance.
 */
function bootstrapAccuracyCI(
  policy: Map<RLState, RLState>,
  fallback: RLState | null,
  evalSet: Bigram[],
  B: number,
): [number, number] {
  if (evalSet.length === 0) return [0, 0];
  const n = evalSet.length;
  const scores: number[] = [];
  for (let b = 0; b < B; b += 1) {
    let correct = 0;
    for (let i = 0; i < n; i += 1) {
      const bg = evalSet[Math.floor(Math.random() * n)];
      const pred = policy.get(bg.from) ?? fallback;
      if (pred === bg.to) correct += 1;
    }
    scores.push(correct / n);
  }
  scores.sort((a, b) => a - b);
  const lo = scores[Math.max(0, Math.floor(0.025 * B))];
  const hi = scores[Math.min(B - 1, Math.ceil(0.975 * B) - 1)];
  return [lo, hi];
}

export function computeRLTrace(
  events: ArchiveEvent[],
  density: TemporalDensityResult,
): RLTrace {
  const dated = events
    .filter((e): e is ArchiveEvent & { at: string } => Boolean(e.at))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const gapMs = RL_SESSION_GAP_MINUTES * 60 * 1000;

  // First pass: collect all in-session bigrams in chronological order.
  // We keep the ordered list so the 80/20 train/test split below can
  // respect time; shuffling would conflate past/future and inflate
  // apparent generalisation.
  const bigrams: Bigram[] = [];
  let bigramsDroppedCrossSession = 0;
  for (let i = 0; i < dated.length - 1; i += 1) {
    const a = dated[i];
    const b = dated[i + 1];
    const tA = Date.parse(a.at);
    const tB = Date.parse(b.at);
    if (!Number.isFinite(tA) || !Number.isFinite(tB)) continue;
    if (tB - tA > gapMs) {
      bigramsDroppedCrossSession += 1;
      continue;
    }
    const reward = density.countByEventId[b.id] ?? 0;
    bigrams.push({ from: a.primitive, to: b.primitive, reward });
  }

  // Aggregate for transition probabilities (the point estimates used
  // in the UI transition table).
  const pairCounts = new Map<string, number>();
  const pairRewardSum = new Map<string, number>();
  const fromCounts = new Map<RLState, number>();
  for (const bg of bigrams) {
    const key = `${bg.from}→${bg.to}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    pairRewardSum.set(key, (pairRewardSum.get(key) ?? 0) + bg.reward);
    fromCounts.set(bg.from, (fromCounts.get(bg.from) ?? 0) + 1);
  }

  const totalTransitions = Array.from(pairCounts.values()).reduce((s, c) => s + c, 0);

  // Build transition objects with unsmoothed ML probabilities. (The
  // smoothing below is applied only when computing entropy, so the
  // displayed rule "P(a|s) = 94%" remains a direct frequency a reader
  // can verify by counting.)
  const transitions: RLTransition[] = [];
  for (const [key, count] of pairCounts) {
    const [from, to] = key.split("→") as [RLState, RLState];
    const fromTotal = fromCounts.get(from) ?? 0;
    const probability = fromTotal > 0 ? count / fromTotal : 0;
    const probabilityCI = wilsonCI95(count, fromTotal);
    const meanReward = count > 0 ? (pairRewardSum.get(key) ?? 0) / count : 0;
    transitions.push({ from, to, count, probability, probabilityCI, meanReward });
  }

  // Per-state stats. Entropy is reported in BOTH smoothed and unsmoothed
  // forms so a data-engineer reader can see how much the prior moved
  // the estimate for sparse cells.
  const observedStates = ALL_STATES.filter((s) => (fromCounts.get(s) ?? 0) > 0);
  const K = observedStates.length;
  const alpha = RL_ESTIMATOR_CONFIG.laplaceAlpha;
  const states: RLStateStats[] = [];
  for (const state of observedStates) {
    const visitCount = fromCounts.get(state) ?? 0;
    const outgoing = transitions.filter((t) => t.from === state);
    // Unsmoothed entropy: directly from observed probabilities.
    const entropyRaw = entropyBits(outgoing.map((t) => t.probability));
    // Smoothed entropy: add-α over the K observed target states, so
    // each source state's distribution sums to 1 over the same support.
    const smoothedProbs: number[] = observedStates.map((to) => {
      const c = pairCounts.get(`${state}→${to}`) ?? 0;
      return (c + alpha) / (visitCount + alpha * K);
    });
    const entropy = entropyBits(smoothedProbs);
    const topNext = [...outgoing].sort((a, b) => b.count - a.count).slice(0, 3);
    const topNextAccuracy = topNext[0]?.probability ?? 0;
    states.push({
      state,
      visitCount,
      entropy,
      entropyRaw,
      topNextAccuracy,
      // Filled in below once the train/test split has been computed.
      heldOutTopNextAccuracy: null,
      heldOutFromCount: 0,
      topNext,
    });
  }

  // Weighted mean entropy across all states seen.
  const totalVisits = states.reduce((s, st) => s + st.visitCount, 0);
  const meanPolicyEntropy =
    totalVisits > 0
      ? states.reduce((s, st) => s + (st.entropy * st.visitCount) / totalVisits, 0)
      : 0;

  // Uniform baseline: entropy of a uniform policy over observed state
  // cardinality. Comparing meanPolicyEntropy against this tells the
  // reader how predictable their trace is versus a "learn nothing" model.
  const uniformBaselineEntropy = states.length > 0 ? Math.log2(states.length) : 0;

  const sortedByEntropy = [...states].sort((a, b) => a.entropy - b.entropy);
  const mostPredictable = sortedByEntropy[0] ?? null;
  const leastPredictable = sortedByEntropy[sortedByEntropy.length - 1] ?? null;

  // Peak reward: the `to` state whose transitions collectively have the
  // highest mean reward, weighted by count.
  const rewardByTo = new Map<RLState, { weighted: number; count: number }>();
  for (const t of transitions) {
    const slot = rewardByTo.get(t.to) ?? { weighted: 0, count: 0 };
    slot.weighted += t.meanReward * t.count;
    slot.count += t.count;
    rewardByTo.set(t.to, slot);
  }
  let peakRewardState: RLState | null = null;
  let peakMean = -Infinity;
  for (const [s, slot] of rewardByTo) {
    if (slot.count === 0) continue;
    const mean = slot.weighted / slot.count;
    if (mean > peakMean) {
      peakMean = mean;
      peakRewardState = s;
    }
  }

  const topTransitions = [...transitions].sort((a, b) => b.count - a.count).slice(0, 8);

  // Highly-predictable state count: uses unsmoothed probabilities so the
  // "≥90%" threshold reflects what actually showed up in the data, not
  // a post-prior number.
  let highlyPredictableStateCount = 0;
  for (const st of states) {
    const top = st.topNext[0];
    if (top && top.probability >= 0.9) highlyPredictableStateCount += 1;
  }

  // Strongest rule overall: highest probability among transitions with
  // meaningful support (require at least 10 observations to avoid
  // spurious 100%-on-N=1 artefacts).
  const strongestBase =
    [...transitions]
      .filter((t) => t.count >= 10)
      .sort((a, b) => b.probability - a.probability || b.count - a.count)[0] ?? null;

  // --- Fit / evaluate argmax-policy predictor. -----------------------
  // In-sample: fit on all bigrams, evaluate on all bigrams. This is the
  // training-set fit; it IS the `visit-weighted max_a P(a|s)` number
  // algebraically, and we report it explicitly so a reader can see how
  // much of the reported accuracy comes from overfitting.
  const { policy: fullPolicy, fallback: fullFallback } = fitArgmaxPolicy(bigrams);
  const inSampleAccuracy = evalAccuracy(fullPolicy, fullFallback, bigrams);
  const inSampleAccuracyCI = bootstrapAccuracyCI(
    fullPolicy,
    fullFallback,
    bigrams,
    RL_ESTIMATOR_CONFIG.bootstrapResamples,
  );

  // Held-out: chronological 80/20 split. Fit on train, evaluate on test.
  // Chronological (not random) because the question is temporal
  // generalisation — can a model of your past predict your future?
  const splitIdx = Math.floor(bigrams.length * RL_ESTIMATOR_CONFIG.trainFraction);
  const train = bigrams.slice(0, splitIdx);
  const test = bigrams.slice(splitIdx);
  const { policy: trainPolicy, fallback: trainFallback } = fitArgmaxPolicy(train);
  const heldOutAccuracy = evalAccuracy(trainPolicy, trainFallback, test);
  const heldOutAccuracyCI = bootstrapAccuracyCI(
    trainPolicy,
    trainFallback,
    test,
    RL_ESTIMATOR_CONFIG.bootstrapResamples,
  );

  // Per-state held-out accuracy. For each state, filter the test set to
  // bigrams whose source IS that state, then evaluate how often the
  // train-fit argmax policy (or its global fallback) picks the right
  // next state. Surfaces which states generalise cleanly from the first
  // 80% of the trace to the last 20%, and which do not.
  const testFromCountByState = new Map<RLState, number>();
  const testHitCountByState = new Map<RLState, number>();
  for (const bg of test) {
    testFromCountByState.set(bg.from, (testFromCountByState.get(bg.from) ?? 0) + 1);
    const pred = trainPolicy.get(bg.from) ?? trainFallback;
    if (pred === bg.to)
      testHitCountByState.set(bg.from, (testHitCountByState.get(bg.from) ?? 0) + 1);
  }
  for (const st of states) {
    const fc = testFromCountByState.get(st.state) ?? 0;
    const hc = testHitCountByState.get(st.state) ?? 0;
    st.heldOutFromCount = fc;
    st.heldOutTopNextAccuracy = fc > 0 ? hc / fc : null;
  }

  // Data-quality summary. Matters for a reader evaluating whether the
  // downstream numbers are over- or under-powered.
  const eventsTotal = events.length;
  const eventsWithTimestamp = dated.length;
  const firstEventAt = dated[0]?.at ?? null;
  const lastEventAt = dated[dated.length - 1]?.at ?? null;

  // Held-out calibration for the strongest rule. A rule that says
  // "after X, go to Y, P=94%" is only trustworthy if it also holds on
  // data the rule wasn't fit on. We count how often `from` appears in
  // the test set and how often the actual next state was `to`; the
  // resulting rate is the honest check on the 94%.
  let strongestRule: RLTrace["strongestRule"] = null;
  if (strongestBase) {
    let heldOutFromCount = 0;
    let heldOutHitCount = 0;
    for (const bg of test) {
      if (bg.from !== strongestBase.from) continue;
      heldOutFromCount += 1;
      if (bg.to === strongestBase.to) heldOutHitCount += 1;
    }
    const heldOutProbability =
      heldOutFromCount > 0 ? heldOutHitCount / heldOutFromCount : null;
    const heldOutCI =
      heldOutFromCount > 0 ? wilsonCI95(heldOutHitCount, heldOutFromCount) : null;
    strongestRule = {
      ...strongestBase,
      heldOutFromCount,
      heldOutProbability,
      heldOutCI,
    };
  }

  // Plain-language summary. Uses held-out, not in-sample, since that is
  // the number a data-engineer reader would quote.
  let plainLanguage = "Your trace contains no usable in-session transitions yet.";
  if (totalTransitions > 0 && mostPredictable) {
    const predictability =
      meanPolicyEntropy < uniformBaselineEntropy * 0.5
        ? "highly predictable"
        : meanPolicyEntropy < uniformBaselineEntropy * 0.8
          ? "moderately predictable"
          : "close to uniform-random";
    const heldOutPct = Math.round(heldOutAccuracy * 100);
    const ciLo = Math.round(heldOutAccuracyCI[0] * 100);
    const ciHi = Math.round(heldOutAccuracyCI[1] * 100);
    plainLanguage =
      `From ${totalTransitions.toLocaleString()} in-session bigrams, a first-order Markov argmax policy fit on the first 80% of your trace predicts the next event on the held-out last 20% with top-1 accuracy ${heldOutPct}% (95% bootstrap CI ${ciLo}–${ciHi}%). On the same metric the smoothed policy entropy is ${meanPolicyEntropy.toFixed(2)} bits vs. a ${uniformBaselineEntropy.toFixed(2)}-bit uniform baseline — ${predictability}.`;
  }

  return {
    modelVersion: RL_TRACE_MODEL_VERSION,
    totalTransitions,
    states,
    topTransitions,
    meanPolicyEntropy,
    uniformBaselineEntropy,
    inSampleAccuracy,
    inSampleAccuracyCI,
    heldOutAccuracy,
    heldOutAccuracyCI,
    heldOutSize: test.length,
    highlyPredictableStateCount,
    stateCount: states.length,
    strongestRule,
    mostPredictable,
    leastPredictable,
    peakRewardState,
    dataQuality: {
      eventsTotal,
      eventsWithTimestamp,
      bigramsUsable: bigrams.length,
      bigramsDroppedCrossSession,
      firstEventAt,
      lastEventAt,
    },
    plainLanguage,
  };
}
