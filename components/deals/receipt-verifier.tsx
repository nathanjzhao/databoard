"use client";

/**
 * components/deals/receipt-verifier.tsx
 *
 * The public receipt checker. Paste a token, POST it to /api/receipts/verify,
 * render valid/invalid and the fields it attests. No account, no state on the
 * server. An initialToken (from a shared ?token= link) auto-verifies on mount,
 * so a receipt URL is checkable by clicking it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReceiptPayload } from "@/lib/receipts";
import { verifyInclusionHex, verifySth, type Sth } from "@/lib/merkle";
import {
  partySigningBase,
  verifyPartySig,
  type PartyBaseFields,
} from "@/lib/receipt-attest";

type Outcome =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; receipt: ReceiptPayload }
  | { kind: "invalid"; reason: string }
  | { kind: "error"; reason: string };

const TIER_WORD: Record<string, string> = {
  co_attested: "co-attested",
  evidence_committed: "evidence committed",
};

function shortToken(token: string): string {
  const t = (token ?? "").replace(/^v2:/, "");
  return t.slice(0, 4);
}

export function ReceiptVerifier({ initialToken = "" }: { initialToken?: string }) {
  const [token, setToken] = useState(initialToken);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const ranInitial = useRef(false);

  const verify = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setOutcome({ kind: "idle" });
      return;
    }
    setOutcome({ kind: "checking" });
    try {
      const res = await fetch("/api/receipts/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        valid?: boolean;
        receipt?: ReceiptPayload;
        reason?: string;
      };
      if (data.valid && data.receipt) {
        setOutcome({ kind: "valid", receipt: data.receipt });
      } else {
        setOutcome({ kind: "invalid", reason: data.reason ?? "Not a valid receipt." });
      }
    } catch {
      setOutcome({ kind: "error", reason: "Could not reach the verifier. Try again." });
    }
  }, []);

  useEffect(() => {
    if (ranInitial.current) return;
    ranInitial.current = true;
    if (initialToken.trim().length > 0) void verify(initialToken);
  }, [initialToken, verify]);

  return (
    <div className="space-y-5">
      <div className="border border-rule bg-panel px-5 py-4">
        <label className="block">
          <span className="bt-label">Receipt token</span>
          <textarea
            className="bt-input mt-2 h-28 w-full resize-y break-all font-mono text-[0.75rem] leading-relaxed"
            placeholder="rcpt_v1.…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void verify(token)}
            disabled={outcome.kind === "checking" || token.trim().length === 0}
            className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
          >
            {outcome.kind === "checking" ? "Checking…" : "Verify"}
          </button>
          {token.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setToken("");
                setOutcome({ kind: "idle" });
              }}
              className="bt-btn px-3 py-1.5 text-[0.75rem]"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {outcome.kind === "valid" ? <ValidCard receipt={outcome.receipt} /> : null}

      {outcome.kind === "invalid" || outcome.kind === "error" ? (
        <div className="border-l-2 border-red bg-red-wash px-4 py-3.5">
          <div className="bt-label text-red">
            {outcome.kind === "error" ? "Could not check" : "Not verified"}
          </div>
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
            {outcome.reason}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ValidCard({ receipt }: { receipt: ReceiptPayload }) {
  return (
    <div className="border border-rule-strong bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule-strong px-5 py-3">
        <span className="font-mono text-[0.8125rem] uppercase tracking-[0.12em] text-ink">
          Verified
        </span>
        <span className="font-mono text-[0.6875rem] text-ink-faint">
          signature matches this instance
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-10 gap-y-3 px-5 py-4 sm:grid-cols-2">
        <Row label="Tier">{TIER_WORD[receipt.tier] ?? receipt.tier}</Row>
        <Row label="Amount">{receipt.amountBucket} bucket</Row>
        <Row label="Buyer">
          #{shortToken(receipt.buyerToken)}
          {receipt.buyerIsOther ? " (off-list)" : ""}
        </Row>
        <Row label="Attested">
          {receipt.attestedAt > 0
            ? new Date(receipt.attestedAt).toISOString().slice(0, 10)
            : "unknown"}
        </Row>
        <Row label="Handles">{receipt.participants.join(", ")}</Row>
        <Row label="Deal id">{receipt.dealId}</Row>
        <Row label="Schema">{receipt.schemaSha256.slice(0, 16)}…</Row>
        <Row label="Commit">
          {receipt.commit ? receipt.commit.slice(0, 12) : "not stamped"}
        </Row>
      </dl>
      {receipt.attest && receipt.log ? (
        <PartyAttestation receipt={receipt} />
      ) : null}
      {receipt.log ? <LogInclusion log={receipt.log} /> : null}
      <p className="border-t border-rule px-5 py-3 text-[0.6875rem] leading-relaxed text-ink-faint">
        Valid means DataBoard signed this and nothing in it was altered. On its
        own the platform MAC does not prove who paid or that the platform did
        not mint it, because that key is the platform&apos;s; the party
        signatures above, when present and complete, are what remove that
        (co-attested deals cannot be forged without the parties&apos; keys).{" "}
        <a
          href="/transparency/verification#receipts"
          className="text-blue hover:text-amber"
        >
          What a receipt proves
        </a>
        .
      </p>
    </div>
  );
}

/** The party base fields, reconstructed from a receipt token in the browser. */
function baseFieldsFromReceipt(receipt: ReceiptPayload): PartyBaseFields | null {
  if (!receipt.log || !receipt.attest) return null;
  return {
    dealId: receipt.dealId,
    tier: receipt.tier,
    buyerToken: receipt.buyerToken,
    amountBucket: receipt.amountBucket,
    buyerIsOther: receipt.buyerIsOther,
    schemaSha256: receipt.schemaSha256,
    commit: receipt.commit,
    attestedAt: receipt.attestedAt,
    seq: receipt.log.seq,
    participants: receipt.participants,
    signers: receipt.attest.signers,
  };
}

type SignerRow = {
  handle: string;
  /** The signature over the base verifies against the pubkey in the receipt. */
  sigValid: boolean;
  /**
   * Directory cross-check: null = pending, true = matches, false =
   * mismatch/absent, "unavailable" = the directory needs a session (a
   * logged-out verifier), so the cross-check was skipped, not failed.
   */
  keyMatches: boolean | null | "unavailable";
};

/**
 * Party-signature verification, done entirely in the browser. The load-bearing
 * check is (1): the Ed25519 signature verifies over the recomputed canonical
 * receipt bytes against the pubkey the receipt CARRIES in its own roster. That
 * needs no account and no server, so a public verifier is fully able to confirm
 * a receipt. The second check (2) is a cross-check that the carried pubkey is
 * also the one the board's directory (/api/signing/pubkey) holds for the handle;
 * it closes the loop where a forged receipt carries a made-up key it also signed
 * with. The directory now requires a session (F-01: a public directory was an
 * offline password oracle), so a logged-out verifier sees this cross-check as
 * "sign in", not as a failure. Honest residual, stated on /transparency: the
 * directory is operator-served, so this is trust-on-first-use, not key
 * transparency.
 */
function PartyAttestation({ receipt }: { receipt: ReceiptPayload }) {
  const [rows, setRows] = useState<SignerRow[] | null>(null);

  const fields = baseFieldsFromReceipt(receipt);
  const attest = receipt.attest;

  useEffect(() => {
    if (!fields || !attest) return;
    let live = true;
    const base = partySigningBase(fields);
    const sigByHandle = new Map(attest.sigs.map((s) => [s.handle, s.sig]));

    // Signature math is synchronous; compute it immediately, then fill in the
    // directory match as the lookups return.
    const initial: SignerRow[] = fields.signers.map((s) => {
      const sig = sigByHandle.get(s.handle);
      return {
        handle: s.handle,
        sigValid: sig ? verifyPartySig(base, s.pubkey, sig) : false,
        keyMatches: null,
      };
    });
    setRows(initial);

    (async () => {
      const resolved = await Promise.all(
        fields.signers.map(async (s): Promise<{ handle: string; keyMatches: boolean | "unavailable" }> => {
          try {
            const res = await fetch(
              `/api/signing/pubkey?handle=${encodeURIComponent(s.handle)}`,
              { headers: { accept: "application/json" } },
            );
            const data = (await res.json().catch(() => null)) as
              | { pubkey?: string | null }
              | null;
            // The directory is session-gated now (F-01). A logged-out verifier
            // is bounced (401, or a redirect to the gate that is not our JSON):
            // that is "cross-check unavailable", not a mismatch. A real answer
            // always carries a `pubkey` field (possibly null).
            if (!res.ok || !data || !("pubkey" in data)) {
              return { handle: s.handle, keyMatches: "unavailable" };
            }
            return { handle: s.handle, keyMatches: data.pubkey === s.pubkey };
          } catch {
            return { handle: s.handle, keyMatches: "unavailable" };
          }
        }),
      );
      if (!live) return;
      const matchByHandle = new Map(resolved.map((r) => [r.handle, r.keyMatches]));
      setRows(
        initial.map((r) => ({
          ...r,
          keyMatches: matchByHandle.get(r.handle) ?? "unavailable",
        })),
      );
    })();

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  if (!fields || !attest) return null;

  const total = fields.signers.length;
  const signed = (rows ?? []).filter((r) => r.sigValid).length;
  const allSigned = total > 0 && signed === total;
  const allMatch =
    rows != null && rows.length > 0 && rows.every((r) => r.keyMatches === true);
  const crossCheckUnavailable =
    rows != null && rows.some((r) => r.keyMatches === "unavailable");

  return (
    <div className="border-t border-rule px-5 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="bt-label">Party signatures</div>
        <span className="font-mono text-[0.6875rem] text-ink-faint">
          {signed} of {total} signed
        </span>
      </div>
      <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-dim">
        {allSigned ? (
          <>
            <span className="text-green">✓</span> Every named party signed this
            receipt with their own key, verified in your browser.
            {allMatch
              ? " Each key matches the board's directory for its handle."
              : crossCheckUnavailable
                ? " Sign in to also cross-check each key against the board's directory."
                : ""}
          </>
        ) : (
          <>
            {signed > 0
              ? "Some parties have signed; the rest have not yet."
              : "No party has signed this receipt yet; it stands on the platform MAC alone."}
          </>
        )}
      </p>
      <ul className="mt-2.5 divide-y divide-rule border-t border-rule">
        {(rows ?? fields.signers.map((s) => ({ handle: s.handle, sigValid: false, keyMatches: null as SignerRow["keyMatches"] }))).map((r) => (
          <li key={r.handle} className="flex items-center justify-between gap-4 py-1.5">
            <span className="font-mono text-[0.75rem] text-ink">@{r.handle}</span>
            <span className="flex items-center gap-3 font-mono text-[0.625rem] uppercase tracking-[0.1em]">
              <span className={r.sigValid ? "text-green" : "text-red"}>
                {r.sigValid ? "sig ok" : "no sig"}
              </span>
              <span
                className={
                  r.keyMatches === null || r.keyMatches === "unavailable"
                    ? "text-ink-faint"
                    : r.keyMatches
                      ? "text-green"
                      : "text-red"
                }
              >
                {r.keyMatches === null
                  ? "key…"
                  : r.keyMatches === "unavailable"
                    ? "sign in"
                    : r.keyMatches
                      ? "key ok"
                      : "key ?"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type InclusionState =
  | { kind: "checking" }
  | { kind: "in"; treeSize: number }
  | { kind: "out"; reason: string };

/**
 * When a receipt carries its append-only-log coordinates, go the extra step:
 * fetch the inclusion proof and the log key, recompute the Merkle root and
 * check the signed head IN THIS BROWSER, and report that the receipt is in the
 * public log at a signed tree size, not merely that the operator's MAC held.
 */
function LogInclusion({ log }: { log: { seq: number; leafHash: string } }) {
  const [state, setState] = useState<InclusionState>({ kind: "checking" });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [proofRes, keyRes] = await Promise.all([
          fetch(`/api/translog/proof/inclusion?leaf=${encodeURIComponent(log.leafHash)}`),
          fetch("/api/translog/pubkey"),
        ]);
        if (!proofRes.ok || !keyRes.ok) {
          if (live) setState({ kind: "out", reason: "the log did not return a proof" });
          return;
        }
        const proof = (await proofRes.json()) as {
          leafHash: string;
          leafIndex: number;
          treeSize: number;
          auditPath: string[];
          sth: Sth;
        };
        const { publicKey } = (await keyRes.json()) as { publicKey: string };
        const rootOk = verifyInclusionHex({
          leafHash: proof.leafHash,
          leafIndex: proof.leafIndex,
          treeSize: proof.treeSize,
          auditPath: proof.auditPath,
          root: proof.sth.rootHash,
        });
        const sigOk = verifySth(proof.sth, publicKey);
        if (live) {
          setState(
            rootOk && sigOk
              ? { kind: "in", treeSize: proof.treeSize }
              : { kind: "out", reason: "the proof did not verify against the signed head" },
          );
        }
      } catch {
        if (live) setState({ kind: "out", reason: "could not reach the log" });
      }
    })();
    return () => {
      live = false;
    };
  }, [log.leafHash]);

  return (
    <div className="border-t border-rule px-5 py-3">
      {state.kind === "checking" ? (
        <p className="text-[0.6875rem] text-ink-faint">Checking the public log…</p>
      ) : state.kind === "in" ? (
        <p className="text-[0.75rem] leading-relaxed text-ink-dim">
          <span className="text-green">✓</span> And it is in the public log at
          tree size {state.treeSize.toLocaleString("en-US")}: the inclusion
          proof checks in your browser against the signed head.{" "}
          <a href="/transparency/log#verify" className="text-blue hover:text-amber">
            Verify it yourself
          </a>
          .
        </p>
      ) : (
        <p className="text-[0.75rem] leading-relaxed text-ink-faint">
          This receipt carries a log binding, but the inclusion proof could not
          be confirmed right now ({state.reason}).{" "}
          <a href="/transparency/log#verify" className="text-blue hover:text-amber">
            Check on the log page
          </a>
          .
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="bt-label">{label}</dt>
      <dd className="break-all font-mono text-[0.75rem] leading-snug text-ink">
        {children}
      </dd>
    </div>
  );
}
