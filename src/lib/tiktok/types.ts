export type Confidence = "low" | "medium" | "high";

export type RenderPrimitive =
  | "attention"
  | "preference"
  | "intent"
  | "social"
  | "account"
  | "unknown";

export type ArchiveEvent = {
  id: string;
  sourceFile: string;
  jsonPath?: string;
  primitive: RenderPrimitive;
  /** Short human-readable summary of the underlying record */
  label: string;
  /** ISO timestamp when parsable */
  at: string | null;
  /** Truncated JSON or text snippet for inspection */
  rawPreview: string;
};

/** Whether this trace reads as mostly “service residue” vs surplus amenable to prediction products. */
export type SurplusVerdict = "likely_surplus" | "mixed" | "unclear";
export type SignalType =
  | "explicit_feedback_actions"
  | "watch_time_or_consumption_signals"
  | "text_query_intent_signals"
  | "social_graph_interaction_signals"
  | "account_or_session_linkage_signals"
  | "device_fingerprint_signals"
  | "location_or_locale_signals"
  | "topic_or_hashtag_signals"
  | "low_structured_signal_content";

export type InferenceUncertainty = {
  /** Completeness and parse quality of the row payload itself. */
  dataCompleteness: Confidence;
  /** Strength/variety of extracted behavior signals. */
  signalStrength: Confidence;
  /** How strongly this row can be linked across sessions/identity attributes. */
  linkageStrength: Confidence;
  /** Optional note when small threshold changes could alter verdict near cutoffs. */
  counterfactualSensitivity?: "stable" | "borderline";
};

export type RowInference = {
  primitive: RenderPrimitive;
  /** How observed content in the row can be operationalized by ranking/targeting systems. */
  rendering: string;
  /** Surplus classification derived from explicit, auditable feature scores. */
  surplus: {
    verdict: SurplusVerdict;
    rationale: string;
  };
  /** Machine-readable feature evidence used to compute this inference. */
  signals: SignalType[];
  /** Quantitative diagnostics exposed for auditability. */
  metrics: {
    surplusScore: number;
    dataQualityScore: number;
    signalRichnessScore: number;
    identityLinkageScore: number;
  };
  uncertainty: InferenceUncertainty;
  confidence: Confidence;
  evidence: string;
  /** Typical optimization pathway consistent with observed row features. */
  loop: string;
};

export type ParsedArchive = {
  inventory: { path: string }[];
  warnings: string[];
  events: ArchiveEvent[];
};
