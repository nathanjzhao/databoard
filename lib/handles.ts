/**
 * lib/handles.ts
 *
 * Handles are assigned, not chosen. A chosen username is the one field in
 * the whole design that a person can use to point straight back at
 * themselves ("nathan"), and nothing server-side can stop that. So the
 * server picks: two words from short curated lists, joined with a dash,
 * matching USERNAME_RE. Roughly 14k combinations; on collision a two-digit
 * suffix is added, which keeps the space comfortably larger than the board.
 *
 * Server-only (node:crypto). The word lists are deliberately bland: nothing
 * that reads as a real name, a place, or a company.
 */

import { randomInt } from "node:crypto";

const FIRST = [
  "amber", "ashen", "basalt", "birch", "brass", "brief", "brisk", "calm",
  "cedar", "chalk", "cinder", "civil", "clear", "cobalt", "cold", "copper",
  "coral", "crisp", "dusk", "early", "ember", "even", "faint", "fallow",
  "fern", "flint", "fog", "frost", "gilt", "granite", "gravel", "grey",
  "half", "hazel", "hollow", "humble", "idle", "indigo", "iron", "ivory",
  "jade", "keen", "late", "lean", "linen", "long", "low", "lunar",
  "marble", "mild", "midnight", "moss", "mute", "near", "north", "oak",
  "ochre", "olive", "open", "pale", "paper", "pewter", "plain", "quiet",
  "rain", "raw", "rust", "sable", "salt", "sand", "shale", "sharp",
  "silent", "slate", "slow", "smoke", "sober", "soft", "spare", "stark",
  "steel", "still", "stone", "tall", "tidal", "tin", "umber", "vellum",
  "violet", "wax", "west", "wide", "wild", "willow", "winter", "wool",
] as const;

const SECOND = [
  "abacus", "anchor", "annex", "archive", "atlas", "audit", "aviary", "badger",
  "ballot", "beacon", "bellows", "binder", "bison", "bobbin", "bracket", "brook",
  "cairn", "caliper", "canvas", "cartel", "census", "cipher", "clerk", "column",
  "compass", "copy", "corbel", "cormorant", "crane", "crossing", "curlew", "dial",
  "docket", "dovetail", "drift", "ember", "falcon", "ferry", "folio", "forge",
  "fox", "gannet", "gauge", "glacier", "harbor", "heron", "hinge", "index",
  "jetty", "kestrel", "kiln", "lantern", "lathe", "ledger", "lever", "lighthouse",
  "linnet", "lockbox", "loom", "lynx", "magpie", "manifest", "marten", "meadow",
  "meridian", "mortar", "otter", "pallet", "paddock", "pennant", "pier", "plover",
  "plumb", "quarry", "quill", "ration", "record", "register", "relay", "ridge",
  "rivet", "roster", "saddle", "sextant", "shoal", "signal", "sparrow", "spindle",
  "stanza", "stoat", "summit", "tally", "tern", "tiller", "trail", "vault",
] as const;

export function generateHandle(): string {
  return `${FIRST[randomInt(FIRST.length)]}-${SECOND[randomInt(SECOND.length)]}`;
}

/** Same handle with a two-digit suffix, for the rare collision. */
export function suffixHandle(handle: string): string {
  return `${handle}-${randomInt(10, 100)}`;
}
