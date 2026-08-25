"use client";

/**
 * components/ask/ask-form.tsx
 *
 * The compose form. Left column is the form, laid out like a docket with
 * numbered sections. Right column is "the receipt": a live rendering of the
 * exact row the database will keep, including the one thing it will not
 * keep, which is the buyer's name.
 *
 * The buyer name never leaves this component in the clear. On submit it is
 * blinded in the browser, evaluated by the server without being seen
 * (RFC 9497 VOPRF, lib/voprf.ts), proof-checked against the published key,
 * and only the finished "v2:" token goes to POST /api/asks. The receipt
 * shows a placeholder because the token exists only after that round trip.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BUYER_OPTIONS, OTHER_BUYER, isKnownBuyer } from "@/lib/buyers";
import { mintBuyerTokenV2 } from "@/lib/voprf";
import type { Exclusivity } from "@/lib/terms";
import { CATEGORIES, MODALITIES, PRICE_BANDS, packTags } from "@/lib/taxonomy";
import { statusForPct } from "@/components/ask/format";
import { MandatePin, type MandatePinState } from "@/components/ask/mandate-commit";

const RANGE_CLASS = [
  "w-full cursor-pointer appearance-none bg-transparent focus:outline-none",
  // webkit track + thumb
  "[&::-webkit-slider-runnable-track]:h-[2px]",
  "[&::-webkit-slider-runnable-track]:bg-rule-strong",
  "[&::-webkit-slider-thumb]:appearance-none",
  "[&::-webkit-slider-thumb]:h-[16px]",
  "[&::-webkit-slider-thumb]:w-[8px]",
  "[&::-webkit-slider-thumb]:-mt-[7px]",
  "[&::-webkit-slider-thumb]:bg-amber",
  "[&::-webkit-slider-thumb]:border",
  "[&::-webkit-slider-thumb]:border-amber-soft",
  // firefox track + thumb
  "[&::-moz-range-track]:h-[2px]",
  "[&::-moz-range-track]:bg-rule-strong",
  "[&::-moz-range-thumb]:h-[16px]",
  "[&::-moz-range-thumb]:w-[8px]",
  "[&::-moz-range-thumb]:rounded-none",
  "[&::-moz-range-thumb]:border",
  "[&::-moz-range-thumb]:border-amber-soft",
  "[&::-moz-range-thumb]:bg-amber",
].join(" ");

export function AskForm() {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [volume, setVolume] = useState("");
  const [priceBand, setPriceBand] = useState<string>("undisclosed");
  const [pct, setPct] = useState(0);
  const [buyerChoice, setBuyerChoice] = useState("");
  const [buyerOther, setBuyerOther] = useState("");
  const [exclusivity, setExclusivity] = useState<Exclusivity | "">("");
  const [mandate, setMandate] = useState<MandatePinState>({ kind: "none" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similarOpen, setSimilarOpen] = useState<number | null>(null);

  const buyer =
    buyerChoice === OTHER_BUYER ? buyerOther.trim() : buyerChoice;
  const derivedStatus = statusForPct(pct);

  // The quiet hint: once a buyer and category are picked, ask the board how
  // many open asks already carry this buyer's token. The name follows the
  // same blind path as the submit (minted client-side, token cached per
  // name); any failure just means no hint, never a fallback that sends the
  // name. Debounced so typing an off-list name does not mint per keystroke.
  const tokenCache = useRef(new Map<string, string>());
  useEffect(() => {
    setSimilarOpen(null);
    if (buyer.length === 0 || category === "") return;
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        let token = tokenCache.current.get(buyer);
        if (!token) {
          token = await mintBuyerTokenV2(buyer);
          tokenCache.current.set(buyer, token);
        }
        const q = new URLSearchParams({ token, category });
        const res = await fetch(`/api/asks/similar?${q}`);
        if (!res.ok) return;
        const data = (await res.json()) as { sameBuyerOpen?: number };
        if (!stale) setSimilarOpen(Number(data.sameBuyerOpen ?? 0));
      } catch {
        // No hint is the whole failure mode.
      }
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [buyer, category]);

  // A hashed-but-unlabeled mandate blocks posting instead of being dropped
  // silently; the pin section says so next to the label field. Terms are
  // required: an ask that does not state exclusivity does not post.
  const ready =
    title.trim().length >= 8 &&
    category !== "" &&
    buyer.length > 0 &&
    exclusivity !== "" &&
    mandate.kind !== "incomplete" &&
    !busy;

  function toggleTag(t: string) {
    setTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // Blind, evaluate, verify, unblind. The name stays in this tab; only
      // the finished token is in the POST below. Any failure (offline,
      // rate limit, a proof that does not check out) lands in the catch
      // and nothing is submitted. There is no plaintext fallback.
      const buyerTokenV2 = await mintBuyerTokenV2(buyer);
      const res = await fetch("/api/asks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          category,
          description: description.trim(),
          modalityTags: tags,
          volume: volume.trim(),
          priceBand,
          supplyFilledPct: pct,
          buyerTokenV2,
          buyerIsOther: !isKnownBuyer(buyer),
          exclusivity,
          mandate:
            mandate.kind === "ready"
              ? { docHash: mandate.docHash, label: mandate.label }
              : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Posting failed.");
      router.push(`/ask/${data.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <form onSubmit={submit} className="min-w-0 space-y-10">
        {/* ------------------------------------------------ 01 · the ask */}
        <Section n="01" heading="The ask">
          <label className="block">
            <span className="bt-label">Title</span>
            <input
              className="bt-input mt-2"
              autoFocus
              maxLength={140}
              placeholder="Seed trajectories for a household-robotics RL environment"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="bt-label">Category</span>
            <select
              className="bt-input mt-2"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="" disabled>
                Pick one
              </option>
              {CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="bt-label">Description</span>
            <textarea
              className="bt-input mt-2 min-h-[9rem] resize-y leading-relaxed"
              maxLength={4000}
              placeholder="What the data is, what good looks like, what disqualifies a batch. Specific enough to act on, vague enough to stay pseudonymous."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="mt-1.5 block text-[0.75rem] leading-relaxed text-ink-faint">
              Free text is the one place on this board where you can out
              yourself. Nobody scrubs it for you.
            </span>
          </label>
        </Section>

        {/* ---------------------------------------- 02 · shape of the data */}
        <Section n="02" heading="Shape">
          <div>
            <span className="bt-label">Modalities</span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {MODALITIES.map((m) => {
                const on = tags.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleTag(m)}
                    aria-pressed={on}
                    className={[
                      "border px-2.5 py-1 font-mono text-[0.6875rem] transition-colors",
                      on
                        ? "border-ink bg-ink text-void"
                        : "border-rule-strong bg-panel-2 text-ink-faint hover:border-ink-ghost hover:text-ink-dim",
                    ].join(" ")}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="bt-label">Volume</span>
              <input
                className="bt-input mt-2"
                maxLength={80}
                placeholder="50k trajectories, 2k hours, 9k items"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="bt-label">Price band</span>
              <select
                className="bt-input mt-2"
                value={priceBand}
                onChange={(e) => setPriceBand(e.target.value)}
              >
                {PRICE_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-[0.75rem] text-ink-faint">
                Bands only.
              </span>
            </label>
          </div>
        </Section>

        {/* ------------------------------------------- 03 · supply filled */}
        <Section n="03" heading="Already filled">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="bt-label">Supply already filled</span>
              <span className="font-mono text-[1.5rem] leading-none tabular-nums text-amber">
                {pct}
                <span className="text-[0.875rem] text-ink-faint">%</span>
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className={`${RANGE_CLASS} mt-4`}
              aria-label="Percent of supply already filled"
            />
            <div className="mt-2 flex justify-between font-mono text-[0.625rem] text-ink-ghost">
              <span>0 · nothing yet</span>
              <span>100 · done, why post</span>
            </div>
            <p
              className={[
                "mt-3 border-l-2 pl-3 text-[0.8125rem] leading-relaxed transition-colors",
                pct >= 70
                  ? "border-amber text-amber"
                  : "border-rule text-ink-faint",
              ].join(" ")}
            >
              {pct >= 70
                ? `An ask that is already ${pct}% filled is probably not worth posting. This board is for the gap, not the victory lap.`
                : "This sets the meter on the board. Posting means the remainder is still wanted."}
            </p>
          </div>
        </Section>

        {/* ------------------------------------------------ 04 · the buyer */}
        <Section n="04" heading="The buyer">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="bt-label">Buying lab</span>
              <select
                className="bt-input mt-2"
                value={buyerChoice}
                onChange={(e) => setBuyerChoice(e.target.value)}
              >
                <option value="" disabled>
                  Pick from the list
                </option>
                {BUYER_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>

            {buyerChoice === OTHER_BUYER ? (
              <label className="block">
                <span className="bt-label">Name the buyer</span>
                <input
                  className="bt-input mt-2"
                  maxLength={80}
                  placeholder="Exact name, consistently spelled"
                  value={buyerOther}
                  onChange={(e) => setBuyerOther(e.target.value)}
                />
              </label>
            ) : null}
          </div>
          <p className="text-[0.75rem] leading-relaxed text-ink-faint">
            Blinded before send: the name is scrambled in this tab and the
            server computes its token without ever seeing it. Pick from the
            list so tokens line up.{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              How tokens work
            </Link>
          </p>
          {similarOpen !== null && similarOpen > 0 ? (
            <p className="border-l-2 border-rule pl-3 font-mono text-[0.6875rem] text-ink-faint">
              {similarOpen} open {similarOpen === 1 ? "ask" : "asks"} already{" "}
              {similarOpen === 1 ? "names" : "name"} this buyer.
            </p>
          ) : null}
        </Section>

        {/* -------------------------------------------------- 05 · terms */}
        <Section n="05" heading="Terms">
          <div role="radiogroup" aria-label="Exclusivity" className="grid gap-2 sm:grid-cols-2">
            <ExclusivityOption
              value="exclusive"
              term="Exclusive"
              line="Supply sold here cannot be resold elsewhere."
              selected={exclusivity === "exclusive"}
              onSelect={() => setExclusivity("exclusive")}
            />
            <ExclusivityOption
              value="nonexclusive"
              term="Non-exclusive"
              line="Suppliers may reuse the supply elsewhere."
              selected={exclusivity === "nonexclusive"}
              onSelect={() => setExclusivity("nonexclusive")}
            />
          </div>
          <p className="text-[0.75rem] leading-relaxed text-ink-faint">
            Required. Shown on the board next to the ask, so suppliers know
            whether overlap means competition before they reach out.
          </p>
        </Section>

        {/* ---------------------------------------------- 06 · the mandate */}
        <Section n="06" heading="Pin a mandate document">
          <MandatePin onChange={setMandate} />
        </Section>

        {/* --------------------------------------------------------- submit */}
        {error ? (
          <div className="border-l-2 border-red bg-red-wash px-4 py-3 text-[0.8125rem] text-ink">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-rule pt-6 sm:flex-row sm:items-center sm:gap-4">
          <button
            type="submit"
            disabled={!ready}
            className="bt-btn bt-btn-primary w-full px-6 py-2.5 sm:w-auto"
          >
            {busy ? "Posting" : "Post to the board"}
          </button>
          <span className="text-[0.75rem] text-ink-faint">
            Posts under your handle. Edits after: supply and close only.
          </span>
        </div>
      </form>

      {/* ------------------------------------------------------ the receipt */}
      <Receipt
        title={title}
        category={category}
        tags={tags}
        volume={volume}
        priceBand={priceBand}
        pct={pct}
        buyer={buyer}
        derivedStatus={derivedStatus}
        exclusivity={exclusivity}
        mandate={mandate}
      />
    </div>
  );
}

/**
 * One of the two terms. A real radio under the styling, so keyboards and
 * screen readers get the native semantics.
 */
function ExclusivityOption({
  value,
  term,
  line,
  selected,
  onSelect,
}: {
  value: string;
  term: string;
  line: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={[
        "block cursor-pointer border px-3.5 py-3 transition-colors",
        selected
          ? "border-ink bg-ink"
          : "border-rule-strong bg-panel-2 hover:border-ink-ghost",
      ].join(" ")}
    >
      <input
        type="radio"
        name="exclusivity"
        value={value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        className={[
          "block font-mono text-[0.6875rem] uppercase tracking-[0.1em]",
          selected ? "text-void" : "text-ink-dim",
        ].join(" ")}
      >
        {term}
      </span>
      <span
        className={[
          "mt-1 block text-[0.75rem] leading-relaxed",
          selected ? "text-void/70" : "text-ink-faint",
        ].join(" ")}
      >
        {line}
      </span>
    </label>
  );
}

function Section({
  n,
  heading,
  children,
}: {
  n: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-5">
      <legend className="mb-5 flex w-full items-baseline gap-3 border-b border-rule pb-2.5">
        <span className="font-mono text-[0.6875rem] text-amber">{n}</span>
        <span className="bt-label text-ink-dim">{heading}</span>
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * The row the database will keep, rendered live, column by column. The point
 * is that there is nothing else: what this panel shows is the entire
 * server-side residue of the form on the left.
 */
function Receipt({
  title,
  category,
  tags,
  volume,
  priceBand,
  pct,
  buyer,
  derivedStatus,
  exclusivity,
  mandate,
}: {
  title: string;
  category: string;
  tags: string[];
  volume: string;
  priceBand: string;
  pct: number;
  buyer: string;
  derivedStatus: string;
  exclusivity: Exclusivity | "";
  mandate: MandatePinState;
}) {
  const rows = useMemo(() => {
    const base: [string, string][] = [
      ["title", title.trim() || "·"],
      ["category", category || "·"],
      ["modality_tags", packTags(tags) || "·"],
      ["volume", volume.trim() || "·"],
      ["price_band", priceBand],
      ["supply_filled_pct", String(pct)],
      ["buyer_token", buyer ? "v2:???? · blinded in this tab" : "·"],
      ["buyer_is_other", buyer ? (isKnownBuyer(buyer) ? "0" : "1") : "·"],
      ["status", derivedStatus],
      ["user_id", "your account id"],
      ["ask_terms.exclusivity", exclusivity || "·"],
    ];
    if (mandate.kind === "ready") {
      // The second table an ask with a pinned mandate writes: a fingerprint
      // and a caption. The document stays where it is.
      base.push(
        ["ask_mandates.doc_hash", `${mandate.docHash.slice(0, 12)}… · hashed in this tab`],
        ["ask_mandates.label", mandate.label],
      );
    }
    return base;
  }, [title, category, tags, volume, priceBand, pct, buyer, derivedStatus, exclusivity, mandate]);

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-24 border border-rule bg-panel">
        <div className="border-b border-rule px-4 py-3">
          <span className="bt-label">The row the database keeps</span>
        </div>
        <dl className="divide-y divide-rule">
          {rows.map(([col, val]) => (
            <div key={col} className="px-4 py-2.5">
              <dt className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-ghost">
                {col}
              </dt>
              <dd className="mt-1 break-words font-mono text-[0.6875rem] leading-relaxed text-ink-dim">
                {val}
              </dd>
            </div>
          ))}
        </dl>
        <div className="border-t border-rule bg-amber-wash px-4 py-3">
          <p className="text-[0.75rem] leading-relaxed text-ink-dim">
            Never sent: the buyer&apos;s name
            {buyer ? (
              <span className="text-amber"> ({buyer})</span>
            ) : null}
            .
          </p>
        </div>
      </div>
    </aside>
  );
}
