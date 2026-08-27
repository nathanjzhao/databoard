"use client";

/**
 * components/deals/deal-form.tsx
 *
 * The record-a-deal form. Same docket layout as the compose form: numbered
 * sections, and the arithmetic laid bare. A deal names a buyer (blinded in
 * this tab and never sent in the clear, same as asks), an optional linked
 * ask, a total, and
 * a split: the reporter's own share plus zero or more named participants,
 * each with an exact dollar share. Shares are uneven on purpose; the live
 * math shows allocated versus total and the unallocated remainder, and blocks
 * submission only when the shares overrun the total.
 *
 * Naming participants creates a deal room: a group thread with everyone on
 * it, so the split can be argued about before anyone confirms.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BUYER_OPTIONS, OTHER_BUYER, isKnownBuyer } from "@/lib/buyers";
import { buyerChip, mintBuyerTokenV2 } from "@/lib/voprf";
import { usdExact } from "@/components/deals/format";
import type { LinkableAsk } from "@/lib/deals";

type ParticipantDraft = {
  key: number;
  username: string;
  share: string;
};

/** "1,250,000", "$1.25m"? No. Whole dollars, commas tolerated, nothing else. */
function parseUsd(raw: string): number | null {
  const t = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t.length === 0) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

let nextKey = 1;

export function DealForm({
  linkableAsks,
  prefillParticipants,
  prefillAskId,
}: {
  linkableAsks: LinkableAsk[];
  /** Usernames to start the participant rows with (e.g. from a thread). */
  prefillParticipants: string[];
  prefillAskId: string | null;
}) {
  const router = useRouter();

  const [buyerChoice, setBuyerChoice] = useState("");
  const [buyerOther, setBuyerOther] = useState("");
  const [askId, setAskId] = useState(prefillAskId ?? "");
  const [total, setTotal] = useState("");
  const [myShare, setMyShare] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const [note, setNote] = useState("");
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() =>
    prefillParticipants.map((u) => ({ key: nextKey++, username: u, share: "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buyer = buyerChoice === OTHER_BUYER ? buyerOther.trim() : buyerChoice;

  const totalUsd = parseUsd(total);
  const myShareUsd = parseUsd(myShare);
  const shareValues = participants.map((p) => parseUsd(p.share));
  const allocated =
    (myShareUsd ?? 0) + shareValues.reduce<number>((s, v) => s + (v ?? 0), 0);
  const remainder = totalUsd == null ? null : totalUsd - allocated;
  const overAllocated = remainder != null && remainder < 0;

  const rowsComplete = participants.every(
    (p, i) => p.username.trim().length > 0 && shareValues[i] != null,
  );
  const ready =
    buyer.length > 0 &&
    totalUsd != null &&
    totalUsd > 0 &&
    myShareUsd != null &&
    rowsComplete &&
    !overAllocated &&
    !busy;

  function addRow() {
    setParticipants((prev) => [...prev, { key: nextKey++, username: "", share: "" }]);
  }
  function removeRow(key: number) {
    setParticipants((prev) => prev.filter((p) => p.key !== key));
  }
  function updateRow(key: number, patch: Partial<ParticipantDraft>) {
    setParticipants((prev) =>
      prev.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // Blind, evaluate, verify, unblind; the name stays in this tab and
      // only the finished token is posted. Failures land in the catch and
      // nothing is submitted. There is no plaintext fallback.
      const buyerTokenV2 = await mintBuyerTokenV2(buyer);
      const statedCloseAt = closeDate ? Date.parse(closeDate) : null;
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerTokenV2,
          buyerIsOther: !isKnownBuyer(buyer),
          askId: askId || null,
          totalUsd,
          myShareUsd,
          note: note.trim(),
          participants: participants.map((p, i) => ({
            username: p.username.trim().toLowerCase(),
            shareUsd: shareValues[i],
          })),
          statedCloseAt:
            statedCloseAt != null && Number.isFinite(statedCloseAt)
              ? statedCloseAt
              : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !data.id) throw new Error(data.error ?? "Recording failed.");
      router.push(`/deals/${data.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-[720px] space-y-10">
      {/* -------------------------------------------------- 01 · the deal */}
      <Section n="01" heading="The deal">
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
          ) : (
            <label className="block">
              <span className="bt-label">Total value, USD</span>
              <input
                className="bt-input mt-2 font-mono"
                inputMode="numeric"
                placeholder="150000"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </label>
          )}
        </div>
        {buyerChoice === OTHER_BUYER ? (
          <label className="block">
            <span className="bt-label">Total value, USD</span>
            <input
              className="bt-input mt-2 font-mono"
              inputMode="numeric"
              placeholder="150000"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          </label>
        ) : null}
        <p className="text-[0.75rem] leading-relaxed text-ink-faint">
          Blinded before send: the buyer name is scrambled in this tab and
          the server computes its token without seeing it, as on asks (
          <Link href="/transparency" className="text-blue hover:text-amber">
            how
          </Link>
          ). Figures are stored as typed and shown exact only to people on
          this deal; public surfaces round to the nearest $10k.
        </p>

        <label className="block">
          <span className="bt-label">Linked ask, optional</span>
          <select
            className="bt-input mt-2"
            value={askId}
            onChange={(e) => setAskId(e.target.value)}
          >
            <option value="">No linked ask</option>
            {linkableAsks.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} · @{a.posterUsername} · Buyer #{buyerChip(a.buyerToken)}
              </option>
            ))}
          </select>
        </label>

        <label className="block sm:max-w-[280px]">
          <span className="bt-label">Close date, optional</span>
          <input
            type="date"
            className="bt-input mt-2 font-mono"
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
            aria-label="Close date"
          />
          <span className="mt-1.5 block text-[0.6875rem] leading-relaxed text-ink-faint">
            When the deal actually closed. Record it within two weeks of this
            date and commit evidence on your row, and your referral fee on this
            deal drops 20% (
            <Link href="/invites" className="text-blue hover:text-amber">
              timely-recording credit
            </Link>
            ). A date is stored, nothing else; leave it blank to skip.
          </span>
        </label>
      </Section>

      {/* ------------------------------------------------- 02 · the split */}
      <Section n="02" heading="The split">
        <label className="block sm:max-w-[280px]">
          <span className="bt-label">Your share, USD</span>
          <input
            className="bt-input mt-2 font-mono"
            inputMode="numeric"
            placeholder="60000"
            value={myShare}
            onChange={(e) => setMyShare(e.target.value)}
          />
          <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
            Zero is a real answer. Brokers exist.
          </span>
        </label>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="bt-label">People you brought in</span>
            <button
              type="button"
              onClick={addRow}
              className="bt-btn px-2.5 py-1 text-[0.6875rem]"
            >
              + add participant
            </button>
          </div>
          {participants.length === 0 ? (
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-faint">
              Nobody else? Then this records as a solo deal: it stays a
              claimed-tier entry, counts only toward your own figures, and
              never surfaces publicly beyond that.
            </p>
          ) : (
            <div className="mt-3 space-y-2.5">
              {participants.map((p, i) => (
                <ParticipantRowInput
                  key={p.key}
                  row={p}
                  shareParsed={shareValues[i]}
                  taken={participants
                    .filter((q) => q.key !== p.key)
                    .map((q) => q.username.trim().toLowerCase())}
                  onChange={(patch) => updateRow(p.key, patch)}
                  onRemove={() => removeRow(p.key)}
                />
              ))}
              <p className="text-[0.6875rem] leading-relaxed text-ink-faint">
                Each person confirms or declines their own row from their own
                account. Naming them also opens a deal room thread with
                everyone on it.
              </p>
            </div>
          )}
        </div>

        {/* live math */}
        <div className="border border-rule bg-panel-2 px-4 py-3">
          <dl className="grid grid-cols-3 gap-3">
            <MathCell label="allocated" value={usdExact(allocated)} />
            <MathCell
              label="total"
              value={totalUsd == null ? "·" : usdExact(totalUsd)}
            />
            <MathCell
              label="unallocated"
              value={remainder == null ? "·" : usdExact(Math.max(0, remainder))}
              tone={overAllocated ? "red" : remainder === 0 ? "green" : undefined}
            />
          </dl>
          <p
            className={[
              "mt-2 text-[0.6875rem] leading-relaxed",
              overAllocated ? "text-red" : "text-ink-faint",
            ].join(" ")}
          >
            {overAllocated
              ? `Shares overrun the total by ${usdExact(-(remainder ?? 0))}. The ledger will not take that.`
              : "Shares do not have to cover the total. The remainder is costs, or people who are not on this board."}
          </p>
        </div>
      </Section>

      {/* -------------------------------------------------- 03 · the note */}
      <Section n="03" heading="Note">
        <label className="block">
          <span className="bt-label">Note, optional</span>
          <textarea
            className="bt-input mt-2 min-h-[6rem] resize-y leading-relaxed"
            maxLength={2000}
            placeholder="What was delivered, roughly. Everyone on the deal reads this."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="mt-1.5 block text-[0.75rem] leading-relaxed text-ink-faint">
            Free text is the one place you can out yourself. Nobody scrubs it
            for you.
          </span>
        </label>
      </Section>

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
          {busy ? "Recording" : "Record the deal"}
        </button>
        <span className="text-[0.75rem] text-ink-faint">
          Your own row confirms on record. Everyone else gets asked.
        </span>
      </div>
    </form>
  );
}

/* --------------------------------------------------------- row + pieces */

function ParticipantRowInput({
  row,
  shareParsed,
  taken,
  onChange,
  onRemove,
}: {
  row: ParticipantDraft;
  shareParsed: number | null;
  taken: string[];
  onChange: (patch: Partial<ParticipantDraft>) => void;
  onRemove: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = row.username.trim().toLowerCase();
    if (q.length === 0) {
      setSuggestions([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/deals/usernames?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { usernames?: string[] };
        setSuggestions(
          (data.usernames ?? []).filter((u) => !taken.includes(u)),
        );
      } catch {
        /* aborted or offline; the field still works as plain text */
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.username]);

  const exactMatch = suggestions.includes(row.username.trim().toLowerCase());

  return (
    <div className="flex items-start gap-2.5">
      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[0.8125rem] text-ink-ghost">
          @
        </div>
        <input
          className="bt-input pl-6 font-mono text-[0.8125rem]"
          placeholder="username"
          value={row.username}
          onChange={(e) => {
            onChange({ username: e.target.value });
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          aria-label="Participant handle"
          autoComplete="off"
          spellCheck={false}
        />
        {open && suggestions.length > 0 && !exactMatch ? (
          <ul className="absolute inset-x-0 top-full z-20 mt-1 border border-rule-strong bg-panel-2">
            {suggestions.map((u) => (
              <li key={u}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange({ username: u });
                    setOpen(false);
                  }}
                  className="block w-full px-2.5 py-1.5 text-left font-mono text-[0.75rem] text-ink-dim hover:bg-panel-3 hover:text-ink"
                >
                  @{u}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="w-36 shrink-0">
        <input
          className="bt-input font-mono text-[0.8125rem]"
          inputMode="numeric"
          placeholder="share USD"
          value={row.share}
          onChange={(e) => onChange({ share: e.target.value })}
          aria-label="Participant share in USD"
          aria-invalid={row.share.trim().length > 0 && shareParsed == null}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="bt-btn mt-0.5 px-2 py-1.5 text-[0.6875rem]"
        aria-label="Remove participant row"
      >
        remove
      </button>
    </div>
  );
}

function MathCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "red" | "green";
}) {
  return (
    <div>
      <dt className="bt-label">{label}</dt>
      <dd
        className={[
          "mt-1 font-mono text-[0.9375rem] tabular-nums",
          tone === "red" ? "text-red" : tone === "green" ? "text-green" : "text-ink",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
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
