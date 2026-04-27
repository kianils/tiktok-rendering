/**
 * Client-side sentiment analysis — a lexicon-based NLP model.
 *
 * Why this lives in this project. Sentiment analysis is the cleanest,
 * smallest example of rendering: natural language gets flattened to a
 * scalar a machine-learning system can optimize against. We run it on the
 * user's own text (search queries, comments, captions) to make that
 * transformation visible. We do NOT claim TikTok uses sentiment analysis on
 * this data; the point is pedagogical — "here is what rendering text looks
 * like, literally, when we do it to yours."
 *
 * Model choice. Lexicon-based scoring (AFINN-style valence lexicon) with
 * negation flips and intensifier scaling. No external model file, fully
 * deterministic, fully auditable — the entire "weights" table is visible
 * below and snapshotted by `SENTIMENT_MODEL_VERSION`. This matches the rest
 * of the project's content-first, locally-runnable, no-black-box stance.
 *
 * Known limits. Lexicon models miss sarcasm, context-specific meaning,
 * multi-word idioms, non-English vocabulary, and emoji-only sentiment.
 * Scores are an approximation — useful for showing *that* rendering
 * happens, not for clinical emotion inference. The UI must present this as
 * a demonstration of the rendering process, never as a claim about the
 * user's emotional state.
 */

export const SENTIMENT_MODEL_VERSION = "lexicon-afinn-subset-v1";

/**
 * Valence lexicon (subset). Each entry is a word → score in [-5, +5],
 * following AFINN conventions. Not exhaustive — tuned for the kind of
 * language that appears in short search queries and comments.
 */
export const LEXICON: Readonly<Record<string, number>> = Object.freeze({
  // Strong negative
  hate: -3,
  hated: -3,
  hates: -3,
  awful: -3,
  terrible: -3,
  horrible: -3,
  disgusting: -3,
  worst: -3,
  worthless: -3,
  suicidal: -4,
  depressed: -3,
  anxious: -2,
  lonely: -2,
  exhausted: -2,
  broken: -2,
  hopeless: -3,
  miserable: -3,
  dying: -2,
  cry: -2,
  crying: -2,
  sad: -2,
  angry: -2,
  mad: -2,
  furious: -3,
  scared: -2,
  afraid: -2,
  hurt: -2,
  pain: -2,
  painful: -2,
  tired: -2,
  sick: -2,
  stressed: -2,
  overwhelmed: -2,
  regret: -2,
  struggle: -2,
  struggling: -2,
  fail: -2,
  failed: -2,
  failure: -2,
  ugly: -2,
  bad: -2,
  fat: -1,
  alone: -1,
  empty: -1,
  bored: -1,
  boring: -1,
  annoying: -1,
  annoyed: -1,
  disappointed: -2,
  gross: -2,
  cringe: -1,
  weird: -1,
  awkward: -1,
  dumb: -1,
  stupid: -2,
  wrong: -1,
  confused: -1,
  lost: -1,
  stuck: -1,
  // Mild negative
  worry: -1,
  worried: -1,
  concern: -1,
  problem: -1,
  issue: -1,
  difficult: -1,
  hard: -1,
  slow: -1,
  wait: -1,

  // Neutral / curiosity-adjacent (keep small so noise stays low)
  why: 0,
  how: 0,
  what: 0,

  // Mild positive
  ok: 1,
  okay: 1,
  fine: 1,
  nice: 1,
  cool: 1,
  neat: 1,
  cute: 2,
  funny: 2,
  pretty: 1,
  clean: 1,
  easy: 1,
  fast: 1,
  fresh: 1,
  // Strong positive
  love: 3,
  loved: 3,
  loves: 3,
  loving: 3,
  happy: 3,
  joy: 3,
  joyful: 3,
  excited: 3,
  amazing: 3,
  awesome: 3,
  fantastic: 3,
  wonderful: 3,
  beautiful: 3,
  best: 3,
  incredible: 3,
  perfect: 3,
  gorgeous: 3,
  favorite: 2,
  great: 2,
  good: 2,
  better: 2,
  fun: 2,
  laugh: 2,
  smile: 2,
  hopeful: 2,
  grateful: 3,
  thankful: 3,
  proud: 2,
  confident: 2,
  calm: 2,
  relaxed: 2,
  healed: 2,
  healing: 2,
  recovered: 2,
  safe: 2,
  peaceful: 2,
  inspired: 2,
  motivated: 2,
});

/** Negations flip the sign of the next scored token within a short window. */
export const NEGATIONS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "none",
  "nobody",
  "nothing",
  "nowhere",
  "neither",
  "cannot",
  "cant",
  "dont",
  "doesnt",
  "didnt",
  "wasnt",
  "werent",
  "isnt",
  "arent",
  "wouldnt",
  "shouldnt",
  "wont",
]);

/** Intensifiers scale the magnitude of the next scored token. */
export const INTENSIFIERS: Readonly<Record<string, number>> = Object.freeze({
  very: 1.5,
  really: 1.5,
  so: 1.3,
  too: 1.3,
  extremely: 2.0,
  super: 1.5,
  absolutely: 2.0,
  totally: 1.5,
  completely: 1.5,
});

export type SentimentLabel = "negative" | "neutral" | "positive";

export type SentimentToken = {
  word: string;
  /** Final contribution to the total (after negation/intensifier). */
  score: number;
  /** Whether a preceding negation flipped this token. */
  negated: boolean;
  /** Multiplier applied by a preceding intensifier (1 if none). */
  intensifier: number;
};

export type SentimentResult = {
  /** Raw summed score — unbounded, but typically small integers. */
  score: number;
  /** Normalized to roughly [-1, 1] using tokens.length. */
  normalized: number;
  label: SentimentLabel;
  /** Every token that contributed — useful for showing the rendering visually. */
  tokens: SentimentToken[];
  /** Tokens with non-zero score only — the "hits". */
  hits: SentimentToken[];
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

const NEGATION_WINDOW = 2;

/**
 * Score a piece of text. The algorithm: tokenize, then scan left-to-right
 * tracking whether the most recent negation / intensifier is still active
 * (within NEGATION_WINDOW tokens). For each lexicon hit, apply the
 * intensifier multiplier, flip the sign under negation, and emit a token
 * record so the UI can render the derivation.
 */
export function sentimentScore(text: string): SentimentResult {
  const words = tokenize(text);
  const tokens: SentimentToken[] = [];
  let total = 0;
  let negationActiveUntil = -1;
  let pendingIntensifier = 1;
  let pendingIntensifierExpires = -1;

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (NEGATIONS.has(w)) {
      negationActiveUntil = i + NEGATION_WINDOW;
      continue;
    }
    if (w in INTENSIFIERS) {
      pendingIntensifier = INTENSIFIERS[w];
      pendingIntensifierExpires = i + 1;
      continue;
    }
    const base = LEXICON[w];
    if (base === undefined || base === 0) continue;
    const negated = i <= negationActiveUntil;
    const intensifier = i <= pendingIntensifierExpires ? pendingIntensifier : 1;
    const score = (negated ? -base : base) * intensifier;
    total += score;
    tokens.push({ word: w, score, negated, intensifier });
  }

  // Normalize: divide by sqrt(words.length) so very long text is not
  // artificially inflated, but short emotional phrases still register.
  const denom = Math.max(1, Math.sqrt(words.length));
  const normalized = total / denom;

  let label: SentimentLabel = "neutral";
  if (normalized >= 0.5) label = "positive";
  else if (normalized <= -0.5) label = "negative";

  return {
    score: total,
    normalized,
    label,
    tokens,
    hits: tokens.filter((t) => t.score !== 0),
  };
}

/**
 * Field names whose values are natural-language user text. Match is
 * case-insensitive and substring-based, because TikTok exports use
 * varying casing ("SearchTerm", "search_term", "Search term").
 */
const TEXT_BEARING_FIELD_KEYS: ReadonlyArray<string> = [
  "searchterm",
  "search_term",
  "query",
  "text",
  "content",
  "caption",
  "comment",
  "title",
  "description",
  "message",
  "body",
  "post",
  "note",
  "reply",
  "transcription",
  "transcript",
];

/**
 * Field-name substrings that indicate the value is a machine token, not
 * user prose. These are excluded even if they happen to match a text key
 * as a substring.
 */
const NON_TEXT_FIELD_HINTS: ReadonlyArray<string> = [
  "date",
  "time",
  "id",
  "url",
  "link",
  "ip",
  "hash",
  "device",
  "version",
  "platform",
  "locale",
  "country",
  "path",
  "file",
];

function looksLikeProse(value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  // Reject ISO dates, numeric strings, URLs, hashes, UUIDs.
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(v)) return false;
  if (/^https?:\/\//.test(v)) return false;
  if (/^[0-9a-f]{16,}$/i.test(v)) return false;
  if (/^[0-9.,\s-]+$/.test(v)) return false;
  // Require at least two word-like tokens so a single token id
  // ("abc123") does not get fed to sentiment.
  const wordCount = v.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
  return wordCount >= 2;
}

/**
 * Extract a single clean natural-language string from an ArchiveEvent.
 *
 * Strategy: look inside the parsed rawPreview JSON for a value under one
 * of the known text-bearing keys whose name does not also match a
 * non-text hint. Never read from the label (which is a concatenation of
 * `key: value` pairs and produces duplicated, noisy text). If no keyed
 * match is found, fall back to the longest prose-shaped string among the
 * rawPreview values.
 */
/**
 * Parse a `Key: value` block (newline- or bullet-delimited) and extract
 * the value of the first text-bearing key. TikTok's activity.txt exports
 * are formatted this way — e.g. `Date: ...\nSearch Term: ...` — and JSON
 * parsing will fail on them. Without this path the extractor returns the
 * entire block as "prose," which produces duplicated, noisy display text.
 */
function extractFromKeyValueBlock(text: string): string | null {
  // Split on newlines OR on runs of 2+ spaces (some previews collapse).
  const segments = text
    .split(/\r?\n|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const m = seg.match(/^([A-Za-z][A-Za-z _-]{0,40}?)\s*:\s*(.+)$/);
    if (!m) continue;
    const keyNorm = m[1].toLowerCase().replace(/[\s_-]+/g, "");
    const val = m[2].trim();
    // Skip keys that are obviously metadata.
    if (NON_TEXT_FIELD_HINTS.some((h) => keyNorm.includes(h))) continue;
    if (TEXT_BEARING_FIELD_KEYS.some((k) => keyNorm.includes(k)) && looksLikeProse(val)) {
      return val;
    }
  }
  return null;
}

/**
 * When `Key: value` pairs arrive flattened to a single line (e.g. the
 * original newlines were collapsed to single spaces during preview
 * truncation), the newline/2+-space splitter finds one mega-segment and
 * the prose fallback returns the whole mess. This function walks the
 * text with a forward-scanning regex that treats each capitalised run
 * ending in a colon as a key boundary. Values extend to the next such
 * boundary or end-of-string.
 */
function extractFromFlatKeyValue(text: string): string | null {
  const pattern = /([A-Z][A-Za-z ]{0,40}?)\s*:\s+(.+?)(?=\s+[A-Z][A-Za-z ]{0,40}?\s*:|$)/g;
  const matches: Array<{ key: string; val: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ key: m[1].trim(), val: m[2].trim() });
  }
  // Prefer a text-bearing key that isn't also metadata.
  for (const { key, val } of matches) {
    const keyNorm = key.toLowerCase().replace(/[\s_-]+/g, "");
    if (NON_TEXT_FIELD_HINTS.some((h) => keyNorm.includes(h))) continue;
    if (TEXT_BEARING_FIELD_KEYS.some((k) => keyNorm.includes(k)) && looksLikeProse(val)) {
      return val;
    }
  }
  return null;
}

export function extractTextForSentiment(
  _label: string | null | undefined,
  rawPreview: string | null | undefined,
): string | null {
  if (!rawPreview || rawPreview.trim().length === 0) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(rawPreview);
  } catch {
    // Non-JSON: try three structured extractors in decreasing strictness.
    const kvLines = extractFromKeyValueBlock(rawPreview);
    if (kvLines) return kvLines;
    const kvFlat = extractFromFlatKeyValue(rawPreview);
    if (kvFlat) return kvFlat;
    return looksLikeProse(rawPreview) ? rawPreview.trim() : null;
  }

  if (typeof obj === "string") {
    return looksLikeProse(obj) ? obj : null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const entries = Object.entries(obj as Record<string, unknown>).filter(
    ([, v]) => typeof v === "string",
  ) as [string, string][];

  // 1. Prefer a text-bearing key that does not also look like a non-text key.
  for (const wanted of TEXT_BEARING_FIELD_KEYS) {
    for (const [k, v] of entries) {
      const lk = k.toLowerCase();
      if (!lk.includes(wanted)) continue;
      if (NON_TEXT_FIELD_HINTS.some((h) => lk.includes(h) && h !== wanted)) continue;
      if (looksLikeProse(v)) return v.trim();
    }
  }

  // 2. Fallback: the longest prose-shaped value whose key is not obviously
  //    a non-text hint.
  let best: string | null = null;
  for (const [k, v] of entries) {
    const lk = k.toLowerCase();
    if (NON_TEXT_FIELD_HINTS.some((h) => lk.includes(h))) continue;
    if (!looksLikeProse(v)) continue;
    if (best === null || v.length > best.length) best = v;
  }
  return best ? best.trim() : null;
}

/**
 * Aggregate sentiment across many texts. Used to show archive-level
 * distribution, which is a second-order rendering: many emotional phrases
 * → one summary vector.
 */
export type SentimentDistribution = {
  total: number;
  negative: number;
  neutral: number;
  positive: number;
  meanNormalized: number;
  /** Most negative and most positive items for drill-down. */
  extremes: {
    mostNegative: { text: string; result: SentimentResult } | null;
    mostPositive: { text: string; result: SentimentResult } | null;
  };
};

export function aggregateSentiment(
  texts: string[],
): SentimentDistribution {
  const results = texts.map((t) => ({ text: t, result: sentimentScore(t) }));
  const total = results.length;
  let neg = 0;
  let neu = 0;
  let pos = 0;
  let sum = 0;
  let mostNeg: { text: string; result: SentimentResult } | null = null;
  let mostPos: { text: string; result: SentimentResult } | null = null;
  for (const r of results) {
    if (r.result.label === "negative") neg += 1;
    else if (r.result.label === "positive") pos += 1;
    else neu += 1;
    sum += r.result.normalized;
    if (!mostNeg || r.result.normalized < mostNeg.result.normalized) mostNeg = r;
    if (!mostPos || r.result.normalized > mostPos.result.normalized) mostPos = r;
  }
  return {
    total,
    negative: neg,
    neutral: neu,
    positive: pos,
    meanNormalized: total > 0 ? sum / total : 0,
    extremes: {
      mostNegative: mostNeg && mostNeg.result.normalized < 0 ? mostNeg : null,
      mostPositive: mostPos && mostPos.result.normalized > 0 ? mostPos : null,
    },
  };
}
