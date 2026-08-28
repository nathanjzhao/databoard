"use client";

/**
 * components/exchange/exchange-panel.tsx
 *
 * The commit-encrypt-pay-reveal stepper, with the pay step upgraded to the
 * three-party WireCreditClaim (Feature 1). Every cryptographic operation runs in
 * the browser via lib/exchange.ts: the dataset is chunked and AEAD-encrypted, the
 * manifests and commitments are built, the wire-reference nonce is minted, wire
 * confirmations and bank records are hashed here and never uploaded, and each
 * step is signed with the participant's password-derived Ed25519 key. The server
 * sees commitments, signatures and state transitions; it never sees the dataset,
 * the key, a bank record, or an exact figure.
 *
 * The pay step is no longer a self-reported signal. After the buyer commits its
 * PAYMENT_SENT proof, the seller signs a WireCreditClaim over an observed inbound
 * credit, and the buyer countersigns it (wire_credit_observed) before the seller
 * may reveal the key. The honest UI rule the whole panel follows: before any
 * signature, say what it commits the signer to (steps.ts), and after any step,
 * show the recomputed hash next to the committed one so a party checks the math.
 */

import { useCallback, useEffect, useState } from "react";
import { toB64url, fromB64url } from "@/lib/e2ee";
import {
  DEFAULT_CHUNK_SIZE,
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  WIRE_CLAIM_VERSION,
  WIRE_TERMINAL_STATUSES,
  accountNullifierHex,
  ciphertextRootOf,
  decryptAndVerify,
  deriveSigningKeys,
  dekCommitHex,
  encryptDataset,
  eventHash,
  generateDek,
  isTerminal,
  n15Of,
  newSessionId,
  signLeaf,
  uetrCommitHex,
  verifyChain,
  verifyWireChain,
  wireNonce,
  wireNonceCommitHex,
  wireRecordCommitHex,
  wireReversalCommitHex,
  wireSentCommitHex,
  type ExchangeLeaf,
  type ExchangeRole,
  type SigningKeys,
  type WireClaimLeaf,
  type WireClaimType,
} from "@/lib/exchange";
import { usdRounded10k } from "@/components/deals/format";
import { RUNGS, WIRE_RUNGS, rungIndex, stateLabel, wireStatusLabel } from "./steps";
import { PayProofNote } from "./payproof-note";
import type { SessionView } from "./types";

/* -------------------------------------------------------------- constants */

/** A small demo chunk size so a short dataset still splits into several chunks,
 * making the "chunking caps exposure to one chunk" property visible. */
const DEMO_CHUNK_SIZE = 256;

const SAMPLE_DATASET =
  "row_id,region,signups,revenue_usd\n" +
  Array.from({ length: 24 }, (_, i) =>
    [
      `r${1000 + i}`,
      ["emea", "amer", "apac"][i % 3],
      120 + i * 7,
      (4200 + i * 133).toString(),
    ].join(","),
  ).join("\n") +
  "\n";

/* --------------------------------------------------------------- helpers */

const enc = new TextEncoder();
const dec = new TextDecoder();

function rand(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function short(hex: string, n = 10): string {
  return hex.length <= n ? hex : `${hex.slice(0, n)}…`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked: the value is on screen to copy by hand */
  }
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * The seller's per-session secrets, kept only in this tab's sessionStorage:
 * the DEK and its salt, plus the wire-reference nonce that derives N15. None is
 * ever sent.
 */
type StoredSecrets = { dek: string; dekSalt: string; wireNonce?: string };
function dekStoreKey(sessionId: string): string {
  return `databoard.exchange.v1.${sessionId}`;
}
function saveSecrets(sessionId: string, v: StoredSecrets): void {
  try {
    window.sessionStorage.setItem(dekStoreKey(sessionId), JSON.stringify(v));
  } catch {
    /* private mode / quota: the seller keeps the shown key instead */
  }
}
function loadSecrets(sessionId: string): StoredSecrets | null {
  try {
    const raw = window.sessionStorage.getItem(dekStoreKey(sessionId));
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredSecrets;
    return p.dek && p.dekSalt ? p : null;
  } catch {
    return null;
  }
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

function errText(data: Record<string, unknown>): string {
  const e = typeof data.error === "string" ? data.error : "request failed";
  const d = typeof data.detail === "string" ? data.detail : "";
  return d ? `${e}: ${d}` : e;
}

/* ------------------------------------------------------------- next move */

type MoveKind =
  | "ciphertext_ack"
  | "payment_sent"
  | "wire_claim"
  | "wire_countersign"
  | "dek_reveal"
  | "complete";
type Move = { role: ExchangeRole; kind: MoveKind };

/**
 * Whose move it is and what it is, accounting for the wire sub-state during the
 * payment phase. The exchange state alone is not enough once state is
 * payment_signaled: the wire claim, its countersign, and the reveal all happen
 * there.
 */
function nextMove(session: SessionView): Move | null {
  switch (session.state) {
    case "committed":
      return { role: "buyer", kind: "ciphertext_ack" };
    case "ciphertext_ack":
      return { role: "buyer", kind: "payment_sent" };
    case "payment_signaled":
      switch (session.wireStatus) {
        case "pending":
        case "reversed":
          return { role: "seller", kind: "wire_claim" };
        case "claimed":
          return { role: "buyer", kind: "wire_countersign" };
        case "observed":
          return { role: "seller", kind: "dek_reveal" };
      }
      return null;
    case "dek_revealed":
      return { role: "buyer", kind: "complete" };
    default:
      return null;
  }
}

const MOVE_LABEL: Record<MoveKind, string> = {
  ciphertext_ack: "Ciphertext verified",
  payment_sent: "Payment sent",
  wire_claim: "Wire credit claimed",
  wire_countersign: "Wire credit observed",
  dek_reveal: "Key revealed",
  complete: "Verified and complete",
};

/* ---------------------------------------------------------------- props */

export type ExchangePanelProps = {
  dealId: string;
  viewer: string;
  buyerLabel: string;
  /** Confirmed participants other than the viewer: candidate buyers. */
  counterparties: string[];
  initialSession: SessionView | null;
};

export function ExchangePanel({
  dealId,
  viewer,
  buyerLabel,
  counterparties,
  initialSession,
}: ExchangePanelProps) {
  const [session, setSession] = useState<SessionView | null>(initialSession);
  const [keys, setKeys] = useState<SigningKeys | null>(null);

  const role: ExchangeRole | null = session?.yourRole ?? null;
  const move = session ? nextMove(session) : null;
  const myMove = Boolean(role && move && move.role === role);
  const terminal = session ? isTerminal(session.state) : false;

  /* Poll while waiting on the counterparty, so a two-tab demo advances on its
   * own without a manual refresh. */
  const refresh = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`/api/exchange/${encodeURIComponent(session.id)}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { session: SessionView };
      setSession(data.session);
    }
  }, [session]);

  useEffect(() => {
    if (!session || terminal || myMove) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [session, terminal, myMove, refresh]);

  const chainOk = session ? sessionChainsOk(session) : true;

  return (
    <div className="space-y-8">
      {!session ? (
        <CreateExchange
          dealId={dealId}
          viewer={viewer}
          counterparties={counterparties}
          keys={keys}
          onKeys={setKeys}
          onCreated={setSession}
        />
      ) : (
        <>
          <SessionHeader session={session} move={move} chainOk={chainOk} onRefresh={refresh} />
          <Ladder session={session} />
          <Commitment session={session} buyerLabel={buyerLabel} />
          <PayProofNote />
          {!terminal ? (
            <ActionArea
              session={session}
              role={role!}
              move={move}
              myMove={myMove}
              keys={keys}
              onKeys={setKeys}
              onAdvance={setSession}
            />
          ) : (
            <TerminalNote session={session} />
          )}
          {/* A reversal can be reported by either party after the credit was
              observed, in any state including completed. */}
          {keys && session.wireStatus === "observed" ? (
            <ReversalArea session={session} role={role!} keys={keys} onAdvance={setSession} />
          ) : null}
          <EventLedger session={session} />
        </>
      )}
    </div>
  );
}

function sessionChainsOk(session: SessionView): boolean {
  const exch = verifyChain(session.id, session.dealId, session.events).ok;
  const wire =
    session.wireEvents.length === 0 ||
    (session.wireAnchorHash != null &&
      verifyWireChain(session.id, session.dealId, session.wireAnchorHash, session.wireEvents).ok);
  return exch && wire;
}

/* -------------------------------------------------------------- unlock */

function UnlockKey({
  viewer,
  onKeys,
}: {
  viewer: string;
  onKeys: (k: SigningKeys) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    if (password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const k = await deriveSigningKeys(viewer, password);
      onKeys(k);
      setPassword("");
    } catch {
      setError("Could not derive your signing key in this browser.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-rule bg-panel-2 px-4 py-3.5">
      <div className="bt-label">Unlock your signing key</div>
      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Your steps are signed with an Ed25519 key derived from your password in
        this browser, the sibling of your message key. It never leaves the tab.
        A valid chain proves you took each step, not the operator.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="password"
          className="bt-input max-w-[280px]"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") unlock();
          }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={unlock}
          disabled={busy || password.length === 0}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Deriving…" : "Unlock"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- create form */

function CreateExchange({
  dealId,
  viewer,
  counterparties,
  keys,
  onKeys,
  onCreated,
}: {
  dealId: string;
  viewer: string;
  counterparties: string[];
  keys: SigningKeys | null;
  onKeys: (k: SigningKeys) => void;
  onCreated: (s: SessionView) => void;
}) {
  const [buyer, setBuyer] = useState(counterparties[0] ?? "");
  const [dataset, setDataset] = useState(SAMPLE_DATASET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("");

  if (counterparties.length === 0) {
    return (
      <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
        <div className="bt-label text-amber">No counterparty yet</div>
        <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
          An exchange runs between two confirmed participants of this deal. This
          deal has only you confirmed, so there is nobody to hand data to yet.
          Once another participant confirms their share, the exchange opens.
        </p>
      </div>
    );
  }

  async function propose() {
    if (!keys || !buyer) return;
    setBusy(true);
    setError(null);
    try {
      const sessionId = newSessionId();
      const dataBytes = enc.encode(dataset);
      const dek = generateDek();
      const dekSalt = rand(16);
      // The wire-reference nonce and its rail-safe alias N15, minted here and
      // committed in the genesis leaf so both parties agree on the reference the
      // buyer will put in the wire. The nonce stays on this device.
      const nonce = wireNonce();
      const n15 = n15Of(dealId, nonce);
      const nonceSalt = rand(16);
      setPhase("encrypting in your browser…");
      const encd = await encryptDataset(sessionId, dataBytes, dek, DEMO_CHUNK_SIZE);
      const dekCommit = dekCommitHex(dealId, dekSalt, dek);
      const leaf: ExchangeLeaf = {
        v: EXCHANGE_VERSION,
        sessionId,
        dealId,
        seq: 1,
        type: "commit",
        actorRole: "seller",
        actor: viewer,
        prevHash: GENESIS_PREV_HASH,
        ts: Date.now(),
        data: {
          plaintextRoot: encd.plaintextRoot,
          ciphertextRoot: encd.ciphertextRoot,
          dekCommit,
          dekSalt: toB64url(dekSalt),
          chunkCount: encd.chunkCount,
          chunkSize: encd.chunkSize,
          sizeBucket: encd.sizeBucket,
          buyer,
          // The signed nonce -> N15 mapping: N15 in the clear (it rides the wire
          // memo anyway) plus a commitment to the nonce that derives it.
          n15,
          wireNonceCommit: wireNonceCommitHex(dealId, nonceSalt, nonce),
        },
      };
      const eh = eventHash(leaf);
      const sig = signLeaf(leaf, keys.secretKey);
      setPhase("posting the signed commitment…");
      const created = await postJson("/api/exchange", {
        leaf,
        eventHash: eh,
        signature: sig,
        signerPubkey: keys.publicKey,
      });
      if (!created.ok) {
        setError(errText(created.data));
        setBusy(false);
        setPhase("");
        return;
      }
      // Keep the DEK and the wire nonce on this device only; the seller reveals
      // the DEK after the wire credit is observed.
      saveSecrets(sessionId, {
        dek: toB64url(dek),
        dekSalt: toB64url(dekSalt),
        wireNonce: toB64url(nonce),
      });
      // Demo path: hand the opaque ciphertext to the server as bytes it cannot
      // read, so the buyer can fetch and verify it against the committed root.
      setPhase("uploading opaque ciphertext (demo carrier)…");
      await postJson(`/api/exchange/${sessionId}/blob`, {
        ciphertext: toB64url(encd.ciphertext),
      });
      const session = (created.data.session as SessionView) ?? null;
      if (session) onCreated(session);
    } catch {
      setError("Something failed in the browser crypto. Try again.");
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  const bytes = enc.encode(dataset).length;

  return (
    <div className="space-y-5">
      <div className="border-l-2 border-blue bg-blue-wash px-4 py-3.5">
        <div className="bt-label text-blue">You are the seller</div>
        <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
          Propose the dataset handoff. Your browser chunks and encrypts the data,
          commits a manifest over both the plaintext and the ciphertext plus a
          hash of the key, mints this deal&apos;s wire reference, and signs it.
          The buyer wires payment with that reference; you claim the observed
          credit and the buyer countersigns before you reveal the key. This
          bounds and evidences cheating; it does not make the trade atomic.
        </p>
      </div>

      {!keys ? <UnlockKey viewer={viewer} onKeys={onKeys} /> : null}

      <div className="border border-rule bg-panel px-4 py-4 space-y-4">
        <label className="block">
          <span className="bt-label">Buyer (the counterparty who receives the data)</span>
          <select
            className="bt-input mt-2 max-w-[280px]"
            value={buyer}
            onChange={(e) => setBuyer(e.target.value)}
            disabled={busy}
          >
            {counterparties.map((c) => (
              <option key={c} value={c}>
                @{c}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
            Must be a confirmed participant of this deal.
          </span>
        </label>

        <label className="block">
          <span className="bt-label">Demo dataset ({bytes} bytes)</span>
          <textarea
            className="bt-input mt-2 h-40 w-full font-mono text-[0.75rem] leading-relaxed"
            value={dataset}
            onChange={(e) => setDataset(e.target.value)}
            disabled={busy}
          />
          <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
            Encrypted in {DEMO_CHUNK_SIZE}-byte chunks in this browser. In
            production the dataset is a file and the ciphertext moves off the
            platform; here it rides an opaque server blob so the flow is testable.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={propose}
            disabled={busy || !keys || !buyer || bytes === 0}
            className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
          >
            {busy ? "Working…" : "Encrypt, commit and sign"}
          </button>
          {phase ? <span className="font-mono text-[0.72rem] text-ink-faint">{phase}</span> : null}
          {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- header */

function SessionHeader({
  session,
  move,
  chainOk,
  onRefresh,
}: {
  session: SessionView;
  move: Move | null;
  chainOk: boolean;
  onRefresh: () => void;
}) {
  const terminal = isTerminal(session.state);
  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="bt-label">Exchange</span>
        <span className="font-mono text-[0.75rem] text-ink-dim">{session.id}</span>
        <StateChip session={session} />
        <span className="ml-auto flex items-center gap-3">
          <span
            className={[
              "font-mono text-[0.6875rem]",
              chainOk ? "text-green" : "text-red",
            ].join(" ")}
            title="Recomputed in your browser: every signature and hash-link in the exchange and wire-claim chains."
          >
            {chainOk ? "chain verified ✓" : "chain BROKEN ✗"}
          </span>
          {!terminal ? (
            <button
              type="button"
              onClick={onRefresh}
              className="bt-btn px-3 py-1 text-[0.72rem]"
            >
              Refresh
            </button>
          ) : null}
        </span>
      </div>
      <p className="mt-2 text-[0.8125rem] text-ink-dim">
        You are the <span className="font-mono text-ink">{session.yourRole}</span>. Handoff
        between <span className="font-mono">@{session.seller}</span> (seller) and{" "}
        <span className="font-mono">@{session.buyer}</span> (buyer).{" "}
        {terminal ? null : move ? (
          <span>
            Next move: the{" "}
            <span className="font-mono text-amber">{move.role}</span> ({MOVE_LABEL[move.kind]}).
          </span>
        ) : null}
      </p>
    </div>
  );
}

function StateChip({ session }: { session: SessionView }) {
  const aborted = session.state === "aborted";
  const done = session.state === "completed";
  const reversed = session.wireStatus === "reversed";
  const style =
    aborted || reversed
      ? "border-red/50 bg-red-wash text-red"
      : done
        ? "border-green/50 bg-green-wash text-green"
        : "border-amber-soft/50 bg-amber-wash text-amber";
  const label = reversed ? "Wire reversed" : stateLabel(session.state);
  return (
    <span
      className={[
        "inline-block border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em]",
        style,
      ].join(" ")}
    >
      {label}
    </span>
  );
}

/* -------------------------------------------------------------- ladder */

function Ladder({ session }: { session: SessionView }) {
  const current = rungIndex(session.state);
  const aborted = session.state === "aborted";
  const inPayment = session.state === "payment_signaled";
  return (
    <div>
      <ol className="flex flex-col gap-0 lg:flex-row lg:items-stretch">
        {RUNGS.map((r, i) => {
          const reached = !aborted && i <= current;
          const active = !aborted && i === current;
          return (
            <li key={r.state} className="flex flex-1 items-stretch">
              <div
                className={[
                  "flex-1 border px-3.5 py-3",
                  active
                    ? "border-ink bg-ink"
                    : reached
                      ? "border-rule-strong bg-panel-2"
                      : "border-rule bg-panel",
                ].join(" ")}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={[
                      "font-mono text-[0.625rem]",
                      active ? "text-void" : reached ? "text-amber" : "text-ink-ghost",
                    ].join(" ")}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={[
                      "font-mono text-[0.625rem] uppercase tracking-[0.1em]",
                      active ? "text-void" : reached ? "text-ink-dim" : "text-ink-ghost",
                    ].join(" ")}
                  >
                    {r.label}
                  </span>
                </div>
                <p
                  className={[
                    "mt-1 text-[0.6875rem] leading-snug",
                    active ? "text-void/70" : reached ? "text-ink-faint" : "text-ink-ghost",
                  ].join(" ")}
                >
                  {r.by === "seller" ? "seller signs" : "buyer signs"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {inPayment ? (
        <div className="mt-2 border-l-2 border-amber bg-amber-wash px-4 py-2.5">
          <div className="bt-label text-amber">Wire credit claim</div>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-dim">
            {wireStatusLabel(session.wireStatus)}. This is mutual attestation that
            a payment with reference{" "}
            <span className="font-mono text-ink">{session.n15 ?? "(none)"}</span> was
            sent and observed, not proof a bank irrevocably credited it. The
            terminal state is <span className="font-mono">wire_credit_observed</span>,
            never <span className="font-mono">fiat_final</span>; a credit can still
            be returned or recalled.
          </p>
        </div>
      ) : null}
      {aborted ? (
        <p className="mt-2 text-[0.75rem] text-red">
          This session was aborted. The signed chain up to the abort stays as
          evidence of who moved and who stopped.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- commitment */

function Commitment({ session, buyerLabel }: { session: SessionView; buyerLabel: string }) {
  const rows: [string, string][] = [
    ["plaintext root", session.plaintextRoot],
    ["ciphertext root", session.ciphertextRoot],
    ["key commitment", session.dekCommit],
  ];
  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="bt-label">The commitment the seller signed</div>
      <p className="mt-2 max-w-[68ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Hashes of hashes and a hash of the key. None of it reveals the data. The
        buyer is {buyerLabel} on the deal; the exchange moves the bytes.
      </p>
      <dl className="mt-3 space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <dt className="bt-label w-[8.5rem] shrink-0">{k}</dt>
            <dd className="break-all font-mono text-[0.6875rem] leading-relaxed text-amber">
              {v}
            </dd>
          </div>
        ))}
        {session.n15 ? (
          <div className="flex flex-col gap-0.5 pt-1 sm:flex-row sm:items-baseline sm:gap-3">
            <dt className="bt-label w-[8.5rem] shrink-0">wire reference</dt>
            <dd className="font-mono text-[0.6875rem] text-amber">{session.n15}</dd>
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5 pt-1 sm:flex-row sm:items-baseline sm:gap-3">
          <dt className="bt-label w-[8.5rem] shrink-0">shape</dt>
          <dd className="font-mono text-[0.6875rem] text-ink-dim">
            {session.chunkCount} chunks · {session.chunkSize} B each · {session.sizeBucket}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* --------------------------------------------------------- N15 reference */

function N15Reference({ n15 }: { n15: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-rule bg-panel-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="bt-label">Wire reference (N15)</span>
        <span className="font-mono text-[0.875rem] tracking-wide text-amber">{n15}</span>
        <button
          type="button"
          onClick={async () => {
            await copyText(n15);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="bt-btn px-2 py-0.5 text-[0.6875rem]"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="mt-2 max-w-[68ch] text-[0.75rem] leading-relaxed text-ink-dim">
        Put this in the wire&apos;s End-to-End ID / reference-for-beneficiary AND
        at the START of the remittance text. Honest rail caveats: on Fedwire/CHIPS
        the EndToEndId is ~35 chars but a bank may send NOTPROVIDED; on ACH the
        15-char id may not be displayed and Same-Day ACH caps at $1M; a per-deal
        virtual account (planned, docs/SETTLEMENT.md) is stronger because it is
        routing, not narrative. Acceptance keys off amount, receiving account,
        terminal status and IMAD/UETR, not the reference alone.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- action area */

function ActionArea({
  session,
  role,
  move,
  myMove,
  keys,
  onKeys,
  onAdvance,
}: {
  session: SessionView;
  role: ExchangeRole;
  move: Move | null;
  myMove: boolean;
  keys: SigningKeys | null;
  onKeys: (k: SigningKeys) => void;
  onAdvance: (s: SessionView) => void;
}) {
  const viewer = roleUsername(session, role);

  if (!myMove) {
    return (
      <div className="border border-rule bg-panel-2 px-5 py-4">
        <div className="bt-label">Waiting</div>
        <p className="mt-2 text-[0.8125rem] text-ink-dim">
          It is the{" "}
          <span className="font-mono text-amber">{move?.role ?? "other party"}</span>&apos;s
          move{move ? ` (${MOVE_LABEL[move.kind]})` : ""}. This panel updates on
          its own. You can abort while the trade is open.
        </p>
        {(session.state === "ciphertext_ack" || session.state === "payment_signaled") &&
        session.n15 ? (
          <div className="mt-3">
            <N15Reference n15={session.n15} />
          </div>
        ) : null}
        <div className="mt-3">
          {keys ? (
            <AbortButton session={session} role={role} keys={keys} onAdvance={onAdvance} />
          ) : (
            <UnlockKey viewer={viewer} onKeys={onKeys} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-ink/30 bg-panel px-5 py-4">
      <div className="flex items-baseline gap-2">
        <span className="bt-label text-amber">Your move</span>
        <span className="text-[0.75rem] text-ink-faint">{move ? MOVE_LABEL[move.kind] : ""}</span>
      </div>

      {!keys ? (
        <div className="mt-3">
          <UnlockKey viewer={viewer} onKeys={onKeys} />
        </div>
      ) : (
        <div className="mt-3">
          <StepAction session={session} move={move!} role={role} keys={keys} onAdvance={onAdvance} />
        </div>
      )}

      {keys ? (
        <div className="mt-4 border-t border-rule pt-3">
          <AbortButton session={session} role={role} keys={keys} onAdvance={onAdvance} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- per-step actions */

function StepAction({
  session,
  move,
  role,
  keys,
  onAdvance,
}: {
  session: SessionView;
  move: Move;
  role: ExchangeRole;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  switch (move.kind) {
    case "ciphertext_ack":
      return <VerifyCiphertext session={session} keys={keys} onAdvance={onAdvance} />;
    case "payment_sent":
      return <SendPayment session={session} keys={keys} onAdvance={onAdvance} />;
    case "wire_claim":
      return <WireClaim session={session} keys={keys} onAdvance={onAdvance} />;
    case "wire_countersign":
      return <WireCountersign session={session} keys={keys} onAdvance={onAdvance} />;
    case "dek_reveal":
      return <RevealKey session={session} keys={keys} onAdvance={onAdvance} />;
    case "complete":
      return <DecryptComplete session={session} keys={keys} onAdvance={onAdvance} />;
    default:
      return null;
  }
}

/** Post a next exchange-chain leaf, returning the updated session. */
async function postStep(
  session: SessionView,
  role: ExchangeRole,
  keys: SigningKeys,
  type: ExchangeLeaf["type"],
  data: Record<string, unknown>,
): Promise<{ ok: true; session: SessionView } | { ok: false; error: string }> {
  const leaf: ExchangeLeaf = {
    v: EXCHANGE_VERSION,
    sessionId: session.id,
    dealId: session.dealId,
    seq: session.headSeq + 1,
    type,
    actorRole: role,
    actor: roleUsername(session, role),
    prevHash: session.headHash,
    ts: Date.now(),
    data,
  };
  const eh = eventHash(leaf);
  const sig = signLeaf(leaf, keys.secretKey);
  const res = await postJson(`/api/exchange/${session.id}/events`, {
    leaf,
    eventHash: eh,
    signature: sig,
    signerPubkey: keys.publicKey,
  });
  if (!res.ok) return { ok: false, error: errText(res.data) };
  return { ok: true, session: res.data.session as SessionView };
}

/** Post a next wire-claim-chain leaf (to the /wire endpoint). */
async function postWireStep(
  session: SessionView,
  role: ExchangeRole,
  keys: SigningKeys,
  type: WireClaimType,
  data: Record<string, unknown>,
): Promise<{ ok: true; session: SessionView } | { ok: false; error: string }> {
  const n = session.wireEvents.length;
  const prevHash =
    n === 0 ? session.wireAnchorHash ?? GENESIS_PREV_HASH : session.wireEvents[n - 1].eventHash;
  const leaf: WireClaimLeaf = {
    v: EXCHANGE_VERSION,
    sessionId: session.id,
    dealId: session.dealId,
    seq: n + 1,
    type,
    actorRole: role,
    actor: roleUsername(session, role),
    prevHash,
    ts: Date.now(),
    data,
  };
  const eh = eventHash(leaf);
  const sig = signLeaf(leaf, keys.secretKey);
  const res = await postJson(`/api/exchange/${session.id}/wire`, {
    leaf,
    eventHash: eh,
    signature: sig,
    signerPubkey: keys.publicKey,
  });
  if (!res.ok) return { ok: false, error: errText(res.data) };
  return { ok: true, session: res.data.session as SessionView };
}

function CommitNote({ text }: { text: string }) {
  return (
    <p className="max-w-[68ch] text-[0.8125rem] leading-relaxed text-ink-dim">
      Signing commits you to: <span className="text-ink">{text}</span>
    </p>
  );
}

function VerifyCiphertext({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recomputed, setRecomputed] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/exchange/${session.id}/blob`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { ciphertext?: string | null };
      if (!res.ok || !data.ciphertext) {
        setError("The seller has not delivered the ciphertext yet.");
        setBusy(false);
        return;
      }
      const blob = fromB64url(data.ciphertext);
      const root = blob
        ? ciphertextRootOf(blob, session.chunkSize, session.chunkCount)
        : null;
      setRecomputed(root);
      if (!root || root !== session.ciphertextRoot) {
        setError("Recomputed ciphertext root does NOT match the commitment. Do not proceed.");
        setBusy(false);
        return;
      }
      const posted = await postStep(session, "buyer", keys, "ciphertext_ack", {
        ciphertextRoot: root,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not verify the ciphertext in this browser.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <CommitNote text={RUNGS[1].commits} />
      <p className="text-[0.8125rem] text-ink-dim">
        Download the sealed chunks and recompute their Merkle root here. You are
        acknowledging sealed data you cannot open yet.
      </p>
      {session.n15 ? <N15Reference n15={session.n15} /> : null}
      {recomputed ? (
        <div className="border border-rule bg-panel-2 px-3 py-2">
          <div className="bt-label">recomputed vs committed</div>
          <div className="mt-1 break-all font-mono text-[0.6875rem] text-ink-dim">
            {short(recomputed, 24)}
            <span className={recomputed === session.ciphertextRoot ? "text-green" : "text-red"}>
              {recomputed === session.ciphertextRoot ? "  match" : "  MISMATCH"}
            </span>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Verifying…" : "Verify ciphertext and sign"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------- buyer: payment sent */

function SendPayment({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("wire");
  const [file, setFile] = useState<File | null>(null);
  const [refText, setRefText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitShown, setCommitShown] = useState<string | null>(null);

  const amountNum = Number(amount.replace(/[,$\s]/g, ""));
  const amountBucket = Number.isFinite(amountNum) && amountNum > 0 ? usdRounded10k(amountNum) : "";

  if (!session.n15) {
    return (
      <div className="space-y-2">
        <p className="text-[0.8125rem] text-red">
          This session predates the wire-proof upgrade (no wire reference was
          committed), so it cannot advance to the mutual payment claim. Abort and
          open a new exchange to use proof-of-payment.
        </p>
      </div>
    );
  }

  async function run() {
    if (!amountBucket) {
      setError("Enter the amount you wired so it can be bucketed.");
      return;
    }
    const bytes = file ? await fileBytes(file) : enc.encode(refText.trim());
    if (bytes.length === 0) {
      setError("Attach your wire confirmation (hashed here, never uploaded) or paste its reference.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const salt = rand(16);
      const commit = wireSentCommitHex(salt, amountBucket, session.n15!, bytes);
      setCommitShown(commit);
      const posted = await postStep(session, "buyer", keys, "payment_signaled", {
        paymentCommit: commit,
        method,
        n15: session.n15,
        amountBucket,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not build the payment commitment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <CommitNote text={RUNGS[2].commits} />
      <N15Reference n15={session.n15} />
      <p className="text-[0.8125rem] text-ink-dim">
        Wire the payment off-platform with the reference above, then commit a
        salted hash of your wire confirmation, the amount bucket and the
        reference. The server stores the hash only: never the receipt, never an
        exact amount, never the raw reference. Keep the file yourself to open the
        commitment later if needed.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="bt-label">Amount you wired, USD (kept on your device)</span>
          <input
            className="bt-input mt-2 max-w-[200px]"
            placeholder="80000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
          <span className="mt-1 block text-[0.6875rem] text-ink-faint">
            Bucketed to {amountBucket || "…"}; only the bucket is committed.
          </span>
        </label>
        <label className="block">
          <span className="bt-label">Rail</span>
          <select
            className="bt-input mt-2 max-w-[140px]"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            disabled={busy}
          >
            <option value="wire">wire</option>
            <option value="ach">ach</option>
            <option value="swift">swift</option>
            <option value="other">other</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="bt-label">Wire confirmation file (hashed here, never uploaded)</span>
        <input
          type="file"
          className="mt-2 block w-full text-[0.75rem] text-ink-dim file:mr-3 file:border file:border-rule file:bg-panel-2 file:px-3 file:py-1 file:text-[0.72rem]"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
      </label>
      <label className="block">
        <span className="bt-label">…or paste a reference (fallback, hashed here)</span>
        <input
          className="bt-input mt-2 max-w-[320px]"
          placeholder="wire confirmation #, IMAD…"
          value={refText}
          onChange={(e) => setRefText(e.target.value)}
          disabled={busy || file != null}
        />
      </label>
      {commitShown ? (
        <div className="border border-rule bg-panel-2 px-3 py-2">
          <div className="bt-label">payment-sent commitment</div>
          <div className="mt-1 break-all font-mono text-[0.6875rem] text-amber">{commitShown}</div>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || !amountBucket}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Signing…" : "Commit payment sent and sign"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------- seller: wire claim */

function WireClaim({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const buyerBucket = buyerAmountBucket(session);
  const [amount, setAmount] = useState("");
  const [rail, setRail] = useState("WIRE");
  const [terminalStatus, setTerminalStatus] = useState<string>(WIRE_TERMINAL_STATUSES[0]);
  const [account, setAccount] = useState("");
  const [uetr, setUetr] = useState("");
  const [valueDate, setValueDate] = useState("");
  const [recordFile, setRecordFile] = useState<File | null>(null);
  const [recordText, setRecordText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountNum = Number(amount.replace(/[,$\s]/g, ""));
  const amountBucket = Number.isFinite(amountNum) && amountNum > 0 ? usdRounded10k(amountNum) : "";

  async function run() {
    if (!session.n15) return;
    if (!amountBucket) {
      setError("Enter the amount you observed credited.");
      return;
    }
    if (account.trim().length === 0 || uetr.trim().length === 0 || valueDate.length === 0) {
      setError("Fill the receiving account, the IMAD/UETR, and the value date.");
      return;
    }
    const recBytes = recordFile ? await fileBytes(recordFile) : enc.encode(recordText.trim());
    if (recBytes.length === 0) {
      setError("Attach the bank credit advice (hashed here, never uploaded) or paste its details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const recordSalt = rand(16);
      const uetrSalt = rand(16);
      const posted = await postWireStep(session, "seller", keys, "wire_credit_claim", {
        n15: session.n15,
        rail: rail.trim() || "WIRE",
        amountBucket,
        terminalStatus,
        valueTime: Date.parse(valueDate) || Date.now(),
        bankRecordCommit: wireRecordCommitHex(recordSalt, recBytes),
        accountNullifier: accountNullifierHex(session.seller, account.trim()),
        uetrCommit: uetrCommitHex(uetrSalt, uetr.trim()),
        schemaVersion: WIRE_CLAIM_VERSION,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not build the wire-credit claim.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <CommitNote text={WIRE_RUNGS[0].commits} />
      <p className="text-[0.8125rem] text-ink-dim">
        The buyer committed a payment-sent proof for reference{" "}
        <span className="font-mono text-ink">{session.n15}</span>
        {buyerBucket ? (
          <>
            {" "}at bucket <span className="font-mono text-ink">{buyerBucket}</span>
          </>
        ) : null}
        . Once you see the inbound credit in your receiving bank, claim it. The
        bank record and account number are hashed here and never uploaded.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="bt-label">Amount observed, USD</span>
          <input
            className="bt-input mt-2 max-w-[180px]"
            placeholder="80000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
          <span className="mt-1 block text-[0.6875rem] text-ink-faint">
            Bucketed to {amountBucket || "…"}
            {buyerBucket && amountBucket && buyerBucket !== amountBucket ? (
              <span className="text-red"> · differs from buyer&apos;s {buyerBucket}</span>
            ) : null}
          </span>
        </label>
        <label className="block">
          <span className="bt-label">Rail</span>
          <input
            className="bt-input mt-2 max-w-[120px]"
            value={rail}
            onChange={(e) => setRail(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="bt-label">Terminal bank status</span>
          <select
            className="bt-input mt-2 max-w-[180px]"
            value={terminalStatus}
            onChange={(e) => setTerminalStatus(e.target.value)}
            disabled={busy}
          >
            {WIRE_TERMINAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="bt-label">Value date</span>
          <input
            type="date"
            className="bt-input mt-2 max-w-[180px]"
            value={valueDate}
            onChange={(e) => setValueDate(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="bt-label">Receiving account (hashed to a nullifier here)</span>
          <input
            className="bt-input mt-2 max-w-[260px]"
            placeholder="account / IBAN"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="bt-label">IMAD / UETR (hashed here)</span>
          <input
            className="bt-input mt-2 max-w-[260px]"
            placeholder="UETR or IMAD"
            value={uetr}
            onChange={(e) => setUetr(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <label className="block">
        <span className="bt-label">Bank credit advice (hashed here, never uploaded)</span>
        <input
          type="file"
          className="mt-2 block w-full text-[0.75rem] text-ink-dim file:mr-3 file:border file:border-rule file:bg-panel-2 file:px-3 file:py-1 file:text-[0.72rem]"
          onChange={(e) => setRecordFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
      </label>
      <label className="block">
        <span className="bt-label">…or paste its details (fallback, hashed here)</span>
        <input
          className="bt-input mt-2 max-w-[320px]"
          placeholder="credit advice line"
          value={recordText}
          onChange={(e) => setRecordText(e.target.value)}
          disabled={busy || recordFile != null}
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || !amountBucket}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Signing…" : "Claim the wire credit and sign"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------- buyer: countersign */

function WireCountersign({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = [...session.wireEvents].reverse().find((e) => e.type === "wire_credit_claim");

  async function run() {
    if (!claim || !session.n15) return;
    setBusy(true);
    setError(null);
    try {
      const posted = await postWireStep(session, "buyer", keys, "wire_credit_countersign", {
        claimHash: claim.eventHash,
        n15: session.n15,
        accept: true,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not countersign the claim.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <CommitNote text={WIRE_RUNGS[1].commits} />
      {claim ? (
        <div className="border border-rule bg-panel-2 px-3 py-2 text-[0.6875rem] font-mono text-ink-dim">
          <div>
            rail {String(claim.data.rail)} · {String(claim.data.terminalStatus)} · bucket{" "}
            {String(claim.data.amountBucket)}
          </div>
          <div className="mt-1">
            ref {String(claim.data.n15)} · claim {short(claim.eventHash, 16)}
          </div>
          <div className="mt-1">acct-nullifier {short(String(claim.data.accountNullifier), 16)}</div>
          <div className="mt-1">uetr-commit {short(String(claim.data.uetrCommit), 16)}</div>
        </div>
      ) : (
        <p className="text-[0.8125rem] text-red">No wire-credit claim to countersign yet.</p>
      )}
      <p className="text-[0.8125rem] text-ink-dim">
        Countersigning reaches <span className="font-mono">wire_credit_observed</span>,
        which lets the seller reveal the key. It is mutual attestation, not proof a
        bank irrevocably credited the wire; if it is later returned, either party
        can report a reversal.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || !claim}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Signing…" : "Countersign the wire credit"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------- seller: reveal key */

function RevealKey({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = loadSecrets(session.id);

  async function run() {
    if (!stored) return;
    setBusy(true);
    setError(null);
    try {
      const posted = await postStep(session, "seller", keys, "dek_revealed", {
        dekCommit: session.dekCommit,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not sign the reveal.");
    } finally {
      setBusy(false);
    }
  }

  if (!stored) {
    return (
      <div className="space-y-2">
        <CommitNote text={RUNGS[3].commits} />
        <p className="text-[0.8125rem] text-red">
          The key for this session is not on this device. It lives only in the
          tab where you created the commitment (sessionStorage, never sent). Open
          the exchange there to reveal, or abort and start over.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <CommitNote text={RUNGS[3].commits} />
      <p className="text-[0.8125rem] text-ink-dim">
        The wire credit is mutually observed. Send this key to the buyer directly
        (the deal room thread, or any private channel), then sign the reveal. The
        server records only that you revealed the key matching the committed hash;
        it never sees the key.
      </p>
      <div className="border border-rule bg-panel-2 px-3 py-2">
        <div className="bt-label">the key, to hand to @{session.buyer}</div>
        <div className="mt-1 break-all font-mono text-[0.6875rem] text-amber">{stored.dek}</div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Signing…" : "I have sent it; sign the reveal"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

function DecryptComplete({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [dekInput, setDekInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const dekSalt = String((session.events[0]?.data?.dekSalt as string) ?? "");

  async function run() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const dek = fromB64url(dekInput.trim());
      const salt = fromB64url(dekSalt);
      if (!dek || dek.length !== 32 || !salt) {
        setError("That does not look like a 32-byte key.");
        setBusy(false);
        return;
      }
      const res = await fetch(`/api/exchange/${session.id}/blob`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { ciphertext?: string | null };
      const blob = data.ciphertext ? fromB64url(data.ciphertext) : null;
      if (!blob) {
        setError("Could not fetch the ciphertext.");
        setBusy(false);
        return;
      }
      const result = await decryptAndVerify({
        sessionId: session.id,
        dealId: session.dealId,
        blob,
        dek,
        dekSalt: salt,
        dekCommit: session.dekCommit,
        chunkSize: session.chunkSize,
        chunkCount: session.chunkCount,
        plaintextRoot: session.plaintextRoot,
      });
      if (!result.ok) {
        setError(decryptError(result.error));
        setBusy(false);
        return;
      }
      const text = dec.decode(result.plaintext);
      setPreview(text.length > 600 ? text.slice(0, 600) + "…" : text);
      const posted = await postStep(session, "buyer", keys, "completed", {
        plaintextRoot: result.plaintextRoot,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not decrypt in this browser.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <CommitNote text={RUNGS[4].commits} />
      <p className="text-[0.8125rem] text-ink-dim">
        Paste the key the seller sent you. Your browser checks it against the
        committed hash, decrypts the chunks, and checks the plaintext against the
        committed plaintext root before you sign complete.
      </p>
      <label className="block">
        <span className="bt-label">Key from the seller</span>
        <input
          className="bt-input mt-2 w-full font-mono text-[0.72rem]"
          placeholder="base64url key"
          value={dekInput}
          onChange={(e) => setDekInput(e.target.value)}
          disabled={busy}
        />
      </label>
      {preview ? (
        <div className="border border-green/40 bg-green-wash px-3 py-2">
          <div className="bt-label text-green">decrypted, verified against plaintext root</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] leading-relaxed text-ink-dim">
            {preview}
          </pre>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || dekInput.trim().length === 0}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Decrypting…" : "Decrypt, verify and complete"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------ reversal (either party) */

function ReversalArea({
  session,
  role,
  keys,
  onAdvance,
}: {
  session: SessionView;
  role: ExchangeRole;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("returned");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = [...session.wireEvents].reverse().find((e) => e.type === "wire_credit_claim");

  async function run() {
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      const data: Record<string, unknown> = {
        claimHash: claim.eventHash,
        reason: reason.trim() || "returned",
      };
      if (file) {
        const bytes = await fileBytes(file);
        data.reversalCommit = wireReversalCommitHex(rand(16), bytes);
      }
      const posted = await postWireStep(session, role, keys, "wire_reversed", data);
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
      setOpen(false);
    } catch {
      setError("Could not sign the reversal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-l-2 border-red bg-red-wash px-4 py-3.5">
      <div className="bt-label text-red">Report a reversal</div>
      <p className="mt-2 max-w-[68ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        A wire credit is not final: it can be returned, frozen, or recalled. If
        that happens, report it. The deal reopens and its verified-amount
        weighting reverts. Either party may report it.
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 text-[0.72rem] text-red underline decoration-red/40 underline-offset-2"
        >
          The wire was reversed
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="bt-label">Reason</span>
            <select
              className="bt-input mt-1.5 max-w-[200px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            >
              <option value="returned">returned</option>
              <option value="frozen">frozen</option>
              <option value="recalled">recalled</option>
              <option value="chargeback">chargeback</option>
            </select>
          </label>
          <label className="block">
            <span className="bt-label">Reversal advice (optional, hashed here)</span>
            <input
              type="file"
              className="mt-1.5 block w-full text-[0.75rem] text-ink-dim file:mr-3 file:border file:border-rule file:bg-panel-2 file:px-3 file:py-1 file:text-[0.72rem]"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={run}
              disabled={busy}
              className="bt-btn px-3 py-1 text-[0.72rem] text-red"
            >
              {busy ? "Signing…" : "Sign the reversal"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="text-[0.72rem] text-ink-faint hover:text-ink"
            >
              cancel
            </button>
            {error ? <span className="text-[0.72rem] text-red">{error}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function AbortButton({
  session,
  role,
  keys,
  onAdvance,
}: {
  session: SessionView;
  role: ExchangeRole;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const posted = await postStep(session, role, keys, "abort", {
        reason: reason.trim() || "aborted by " + role,
      });
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      onAdvance(posted.session);
    } catch {
      setError("Could not sign the abort.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[0.72rem] text-ink-faint underline decoration-rule-strong underline-offset-2 hover:text-red"
      >
        Abort this exchange
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="bt-input max-w-[240px] text-[0.75rem]"
        placeholder="reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="bt-btn px-3 py-1 text-[0.72rem] text-red"
      >
        {busy ? "Signing…" : "Sign abort"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={busy}
        className="text-[0.72rem] text-ink-faint hover:text-ink"
      >
        cancel
      </button>
      {error ? <span className="text-[0.72rem] text-red">{error}</span> : null}
    </div>
  );
}

/* ---------------------------------------------------------- terminal */

function TerminalNote({ session }: { session: SessionView }) {
  const done = session.state === "completed";
  return (
    <div
      className={[
        "border-l-2 px-4 py-3.5",
        done ? "border-green bg-green-wash" : "border-red bg-red-wash",
      ].join(" ")}
    >
      <div className={["bt-label", done ? "text-green" : "text-red"].join(" ")}>
        {done ? "Exchange complete" : "Exchange aborted"}
      </div>
      <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
        {done
          ? "The buyer decrypted the dataset and verified it against the committed plaintext root, after a wire credit was mutually observed. The signed chains below are the record: both parties' keys took each step, in order. This is evidence, not atomicity, and the wire credit is observed, not proven final: a later reversal can still be reported."
          : "The chain stops at the abort. Whoever stopped, and after which step, is provable from the signatures below. That is the bound this protocol buys: not a guarantee of completion, but evidence of who did what."}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- event log */

function EventLedger({ session }: { session: SessionView }) {
  return (
    <div className="space-y-6">
      <div>
        <div className="bt-label">Signed event chain</div>
        <p className="mt-2 max-w-[68ch] text-[0.75rem] leading-relaxed text-ink-faint">
          Each row is a leaf: hash-linked to the one before, signed by the acting
          party. Your browser reverified every signature and link above.
        </p>
        <ol className="mt-3 space-y-2">
          {session.events.map((e) => (
            <li key={e.seq} className="border border-rule bg-panel px-4 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[0.625rem] text-ink-ghost">#{e.seq}</span>
                <span className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-ink">
                  {e.type}
                </span>
                <span className="font-mono text-[0.6875rem] text-ink-dim">
                  {e.actorRole} @{e.actor}
                </span>
                <span className="ml-auto font-mono text-[0.625rem] text-ink-faint">
                  sig {short(e.signature, 12)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[0.625rem] text-ink-faint">
                <span>hash {short(e.eventHash, 16)}</span>
                <span>prev {e.prevHash === GENESIS_PREV_HASH ? "genesis" : short(e.prevHash, 12)}</span>
                <span>key {short(e.signerPubkey, 12)}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {session.wireEvents.length > 0 ? (
        <div>
          <div className="bt-label">Signed wire-credit chain</div>
          <p className="mt-2 max-w-[68ch] text-[0.75rem] leading-relaxed text-ink-faint">
            The three-party WireCreditClaim, anchored to the payment-sent event and
            hash-linked among itself. Commitments and buckets only; no bank record,
            no account number.
          </p>
          <ol className="mt-3 space-y-2">
            {session.wireEvents.map((e) => (
              <li key={e.seq} className="border border-rule bg-panel px-4 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[0.625rem] text-ink-ghost">w{e.seq}</span>
                  <span className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-ink">
                    {e.type}
                  </span>
                  <span className="font-mono text-[0.6875rem] text-ink-dim">
                    {e.actorRole} @{e.actor}
                  </span>
                  <span className="ml-auto font-mono text-[0.625rem] text-ink-faint">
                    sig {short(e.signature, 12)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[0.625rem] text-ink-faint">
                  <span>hash {short(e.eventHash, 16)}</span>
                  <span>prev {short(e.prevHash, 12)}</span>
                  <span>key {short(e.signerPubkey, 12)}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- utils */

function roleUsername(session: SessionView, role: ExchangeRole): string {
  return role === "seller" ? session.seller : session.buyer;
}

/** The amount bucket the buyer committed in its payment-sent event, if any. */
function buyerAmountBucket(session: SessionView): string | null {
  const pay = session.events.find((e) => e.type === "payment_signaled");
  const b = pay?.data?.amountBucket;
  return typeof b === "string" && b.length > 0 ? b : null;
}

function decryptError(error: string): string {
  switch (error) {
    case "bad_dek":
      return "That key does not match the committed hash. The seller revealed the wrong key.";
    case "shape":
      return "The ciphertext does not match the committed chunk shape.";
    case "auth":
      return "A chunk failed authentication: wrong key or tampered ciphertext.";
    case "root_mismatch":
      return "The chunks decrypt but do not rebuild the committed plaintext root.";
    default:
      return "Decryption failed.";
  }
}
