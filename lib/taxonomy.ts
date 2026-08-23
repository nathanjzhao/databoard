/**
 * lib/taxonomy.ts
 *
 * The controlled vocabularies the board filters on. Kept in one place so the
 * compose form, the board filters, and the matcher agree on spelling.
 * Pure constants, safe to import from client components.
 */

/**
 * The exact affiliation string an individual signs up under. Anything else is
 * treated as an organization name. Lives here (not lib/verify.ts) so client
 * components can import it without dragging node:crypto into the bundle.
 */
export const INDEPENDENT_AFFILIATION = "independent individual";

export const CATEGORIES = [
  { slug: "rl-env-seed", label: "RL environment seed data" },
  { slug: "eval", label: "Eval / benchmark data" },
  { slug: "human-pref", label: "Human preference data" },
  { slug: "expert-demo", label: "Expert demonstrations" },
  { slug: "domain-corpus", label: "Domain corpus" },
  { slug: "agent-traj", label: "Agent trajectories" },
  { slug: "code-repo", label: "Code and repo data" },
  { slug: "multimodal", label: "Multimodal capture" },
  { slug: "red-team", label: "Red team / safety" },
  { slug: "other", label: "Other" },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

export function categoryLabel(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

export const MODALITIES = [
  "text",
  "code",
  "image",
  "video",
  "audio",
  "screen",
  "tabular",
  "sensor",
  "3d",
] as const;

export type Modality = (typeof MODALITIES)[number];

/**
 * Coarse bands only. An exact figure plus a volume plus a category is close to
 * a fingerprint, so the schema stores a band and the form offers nothing else.
 */
export const PRICE_BANDS = [
  "under $10k",
  "$10k - $50k",
  "$50k - $250k",
  "$250k - $1M",
  "$1M+",
  "undisclosed",
] as const;

export type PriceBand = (typeof PRICE_BANDS)[number];

export const ASK_STATUSES = ["open", "partial", "closed"] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

export const STATUS_LABEL: Record<AskStatus, string> = {
  open: "Open",
  partial: "Partially filled",
  closed: "Closed",
};

/** modality_tags is stored as a comma-separated string. These two are the seam. */
export function packTags(tags: readonly string[]): string {
  return tags
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

export function unpackTags(packed: string): string[] {
  return (packed ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
