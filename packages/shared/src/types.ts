export type SignalType =
  | "SPIKE_DEMAND"
  | "NO_RESULTS_SPIKE"
  | "HIGH_INTEREST_LOW_CONVERSION";

export type EntityType = "query" | "topic" | "product";

export type CtaType = "PUSH_THIS_WEEK" | "FIX_THIS" | "REPOSITION_THIS";

export type InsightStatus = "ACTIVE" | "EXECUTED" | "DISMISSED";

export type EvidenceJson = Record<string, unknown>;

