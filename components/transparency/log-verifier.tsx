"use client";

/**
 * components/transparency/log-verifier.tsx
 *
 * The public, in-browser verifier for the append-only transparency log. It
 * does the checking on the visitor's machine: it fetches proofs from the log's
 * public endpoints, then recomputes the Merkle root and checks the Ed25519
 * signature with lib/merkle.ts (the SAME code the server uses to build the
 * tree). Nothing here trusts the server's word that a proof is valid; it
 * redoes the math and compares.
 *
 *   Inclusion  paste a receipt token or a leaf hash. The page resolves it to a
 *              leaf hash, pulls the audit path, recomputes the root from the
 *              leaf and the path, and checks it against the signed head.
 *   Consistency pick two tree sizes. The page pulls the consistency proof and
 *              checks that the smaller tree is an exact prefix of the larger:
 *              the append-only property, that nothing was rewritten.
 *
 * The log public key is passed in from the server page (and also served at
 * /api/translog/pubkey); every signature check here runs against it.
 */

import { useCallback, useState } from "react";
import {
  verifyInclusionHex,
  verifyConsistencyHex,
  verifySth,
  type Sth,
} from "@/lib/merkle";

const RECEIPT_RE = /^rcpt_v1\./;
const HASH_RE = /^[0-9a-f]{64}$/;

type InclusionResult = {
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  auditPath: string[];
  rootHash: string;
  sth: Sth;
};

type Step = { label: string; ok: boolean; detail?: string };

type InclusionOutcome =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; source: string; steps: Step[]; verified: boolean }
  | { kind: "error"; reason: string };

type ConsistencyOutcome =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; steps: Step[]; verified: boolean }
  | { kind: "error"; reason: string };

export function LogVerifier({ publicKey }: { publicKey: string }) {
  return (
    <div className="space-y-8">
      <InclusionBox publicKey={publicKey} />
      <ConsistencyBox publicKey={publicKey} />
    </div>
  );
}

/* ------------------------------------------------------------- inclusion */

function InclusionBox({ publicKey }: { publicKey: string }) {
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState<InclusionOutcome>({ kind: "idle" });

  const run = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) {
        setOutcome({ kind: "idle" });
        return;
      }
      setOutcome({ kind: "checking" });
      try {
        // Resolve the input to a leaf hash: a receipt token carries one, a
        // 64-hex string is one already.
        let leafHash = "";
        let source = "leaf hash";
        if (RECEIPT_RE.test(value)) {
          source = "receipt";
          const res = await fetch("/api/receipts/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: value }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            valid?: boolean;
            receipt?: { log?: { leafHash?: string } };
            reason?: string;
          };
          if (!data.valid) {
            setOutcome({ kind: "error", reason: data.reason ?? "Not a valid receipt." });
            return;
          }
          const lh = data.receipt?.log?.leafHash;
          if (!lh || !HASH_RE.test(lh)) {
            setOutcome({
              kind: "error",
              reason:
                "This receipt verifies, but it carries no log binding (it predates the transparency log). Nothing to look up.",
            });
            return;
          }
          leafHash = lh.toLowerCase();
        } else if (HASH_RE.test(value.toLowerCase())) {
          leafHash = value.toLowerCase();
        } else {
          setOutcome({
            kind: "error",
            reason: "Paste a receipt token (rcpt_v1.…) or a 64-character leaf hash.",
          });
          return;
        }

        const proofRes = await fetch(
          `/api/translog/proof/inclusion?leaf=${encodeURIComponent(leafHash)}`,
        );
        if (proofRes.status === 404) {
          setOutcome({
            kind: "error",
            reason: "That leaf hash is not in the log.",
          });
          return;
        }
        if (!proofRes.ok) {
          setOutcome({ kind: "error", reason: "The log did not return a proof. Try again." });
          return;
        }
        const proof = (await proofRes.json()) as InclusionResult;

        // Recompute everything, in this browser.
        const rootOk = verifyInclusionHex({
          leafHash: proof.leafHash,
          leafIndex: proof.leafIndex,
          treeSize: proof.treeSize,
          auditPath: proof.auditPath,
          root: proof.sth.rootHash,
        });
        const sigOk = verifySth(proof.sth, publicKey);
        const rootMatches = proof.rootHash.toLowerCase() === proof.sth.rootHash.toLowerCase();

        const steps: Step[] = [
          {
            label: `Leaf sits at index ${proof.leafIndex} in a tree of ${proof.treeSize}`,
            ok: rootOk,
            detail: rootOk
              ? "root recomputed from the audit path matches the signed head"
              : "the recomputed root does NOT match the signed head",
          },
          {
            label: "Signed tree head signature is genuine",
            ok: sigOk,
            detail: sigOk
              ? "Ed25519 signature verifies against the published log key"
              : "signature does NOT verify against the log key",
          },
          {
            label: "The proof's root equals the head's root",
            ok: rootMatches,
          },
        ];
        setOutcome({
          kind: "done",
          source,
          steps,
          verified: rootOk && sigOk && rootMatches,
        });
      } catch {
        setOutcome({ kind: "error", reason: "Could not reach the log. Try again." });
      }
    },
    [publicKey],
  );

  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="bt-label">Inclusion: is this receipt in the log?</div>
      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Paste a deal receipt token, or a raw 64-character leaf hash. The check
        pulls the audit path, recomputes the Merkle root in your browser, and
        compares it to the signed tree head.
      </p>
      <textarea
        className="bt-input mt-3 h-24 w-full resize-y break-all font-mono text-[0.75rem] leading-relaxed"
        placeholder="rcpt_v1.… or a 64-hex leaf hash"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run(input)}
          disabled={outcome.kind === "checking" || input.trim().length === 0}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {outcome.kind === "checking" ? "Checking…" : "Verify inclusion"}
        </button>
        {input.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setInput("");
              setOutcome({ kind: "idle" });
            }}
            className="bt-btn px-3 py-1.5 text-[0.75rem]"
          >
            Clear
          </button>
        ) : null}
      </div>
      {outcome.kind === "done" ? (
        <ResultCard
          verified={outcome.verified}
          heading={
            outcome.verified
              ? `In the public log (checked from the ${outcome.source})`
              : "Did not verify"
          }
          steps={outcome.steps}
        />
      ) : null}
      {outcome.kind === "error" ? <ErrorCard reason={outcome.reason} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------- consistency */

type ConsistencyResult = {
  first: number;
  second: number;
  firstRoot: string;
  secondRoot: string;
  proof: string[];
  firstSth: Sth;
  secondSth: Sth;
};

function ConsistencyBox({ publicKey }: { publicKey: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState<ConsistencyOutcome>({ kind: "idle" });

  const run = useCallback(async () => {
    const f = Number(from);
    const t = Number(to);
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || t < f) {
      setOutcome({ kind: "error", reason: "Enter two sizes with 0 ≤ from ≤ to." });
      return;
    }
    setOutcome({ kind: "checking" });
    try {
      const res = await fetch(`/api/translog/proof/consistency?from=${f}&to=${t}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setOutcome({ kind: "error", reason: data.error ?? "Sizes out of range." });
        return;
      }
      const proof = (await res.json()) as ConsistencyResult;
      const consistent = verifyConsistencyHex({
        first: proof.first,
        second: proof.second,
        firstHash: proof.firstSth.rootHash,
        secondHash: proof.secondSth.rootHash,
        proof: proof.proof,
      });
      const firstSig = verifySth(proof.firstSth, publicKey);
      const secondSig = verifySth(proof.secondSth, publicKey);
      const steps: Step[] = [
        {
          label: `Tree of ${proof.first} is an exact prefix of tree of ${proof.second}`,
          ok: consistent,
          detail: consistent
            ? "nothing before position " + proof.first + " was rewritten, only appended"
            : "the consistency proof does NOT hold",
        },
        { label: `Head at size ${proof.first} is genuinely signed`, ok: firstSig },
        { label: `Head at size ${proof.second} is genuinely signed`, ok: secondSig },
      ];
      setOutcome({ kind: "done", steps, verified: consistent && firstSig && secondSig });
    } catch {
      setOutcome({ kind: "error", reason: "Could not reach the log. Try again." });
    }
  }, [from, to, publicKey]);

  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="bt-label">Consistency: was anything rewritten?</div>
      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Pick two tree sizes from the checkpoint history below. The check proves
        the earlier tree is an exact prefix of the later one: the log only
        appended, it did not edit or reorder anything already recorded.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="bt-label">From size</span>
          <input
            className="bt-input mt-1 w-28 font-mono text-[0.8125rem]"
            inputMode="numeric"
            value={from}
            onChange={(e) => setFrom(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="1"
          />
        </label>
        <label className="block">
          <span className="bt-label">To size</span>
          <input
            className="bt-input mt-1 w-28 font-mono text-[0.8125rem]"
            inputMode="numeric"
            value={to}
            onChange={(e) => setTo(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="latest"
          />
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={outcome.kind === "checking"}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {outcome.kind === "checking" ? "Checking…" : "Verify consistency"}
        </button>
      </div>
      {outcome.kind === "done" ? (
        <ResultCard
          verified={outcome.verified}
          heading={outcome.verified ? "Append-only holds" : "Did not verify"}
          steps={outcome.steps}
        />
      ) : null}
      {outcome.kind === "error" ? <ErrorCard reason={outcome.reason} /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- shared */

function ResultCard({
  verified,
  heading,
  steps,
}: {
  verified: boolean;
  heading: string;
  steps: Step[];
}) {
  return (
    <div
      className={[
        "mt-4 border-l-2 px-4 py-3.5",
        verified ? "border-green bg-green-wash" : "border-red bg-red-wash",
      ].join(" ")}
    >
      <div className={["bt-label", verified ? "text-green" : "text-red"].join(" ")}>
        {heading}
      </div>
      <ul className="mt-2 space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-[0.8125rem] leading-relaxed text-ink-dim">
            <span aria-hidden className={s.ok ? "text-green" : "text-red"}>
              {s.ok ? "✓" : "✗"}
            </span>
            <span>
              {s.label}
              {s.detail ? (
                <span className="block text-[0.6875rem] text-ink-faint">{s.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.6875rem] leading-relaxed text-ink-faint">
        Every line above was recomputed in this browser from the proof the log
        returned, then checked against the published key. The log served the
        proof; it did not get to grade its own answer.
      </p>
    </div>
  );
}

function ErrorCard({ reason }: { reason: string }) {
  return (
    <div className="mt-4 border-l-2 border-amber bg-amber-wash px-4 py-3.5">
      <div className="bt-label text-amber">Nothing to verify</div>
      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">{reason}</p>
    </div>
  );
}
