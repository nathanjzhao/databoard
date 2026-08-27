"use client";

/**
 * components/exchange/exchange-panel.tsx
 *
 * The commit-encrypt-pay-reveal stepper. Every cryptographic operation here
 * runs in the browser via lib/exchange.ts: the dataset is chunked and
 * AEAD-encrypted, the manifests and commitments are built, and each step is
 * signed with the participant's password-derived Ed25519 key. The server sees
 * commitments, signatures and state transitions; it never sees the dataset,
 * the key, or an exact figure.
 *
 * The honest UI rule the whole panel follows: before any signature, say what
 * that signature commits the signer to (steps.ts), and after any step, show
 * the recomputed hash next to the committed one so a party checks the math
 * rather than trusting a label.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toB64url, fromB64url } from "@/lib/e2ee";
import {
  DEFAULT_CHUNK_SIZE,
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  ciphertextRootOf,
  decryptAndVerify,
  deriveSigningKeys,
  dekCommitHex,
  encryptDataset,
  eventHash,
  generateDek,
  isTerminal,
  newSessionId,
  paymentCommitHex,
  signLeaf,
  verifyChain,
  whoMovesNext,
  type ExchangeLeaf,
  type ExchangeRole,
  type SigningKeys,
} from "@/lib/exchange";
import { RUNGS, rungIndex, stateLabel } from "./steps";
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

/** The seller's per-session DEK, kept only in this tab's sessionStorage. Never sent. */
type StoredDek = { dek: string; dekSalt: string };
function dekStoreKey(sessionId: string): string {
  return `databoard.exchange.v1.${sessionId}`;
}
function saveDek(sessionId: string, v: StoredDek): void {
  try {
    window.sessionStorage.setItem(dekStoreKey(sessionId), JSON.stringify(v));
  } catch {
    /* private mode / quota: the seller keeps the shown key instead */
  }
}
function loadDek(sessionId: string): StoredDek | null {
  try {
    const raw = window.sessionStorage.getItem(dekStoreKey(sessionId));
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredDek;
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
  const mover = session ? whoMovesNext(session.state) : null;
  const myMove = Boolean(role && mover && mover.role === role);
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

  const chainOk = session
    ? verifyChain(session.id, session.dealId, session.events).ok
    : true;

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
          <SessionHeader session={session} chainOk={chainOk} onRefresh={refresh} />
          <Ladder session={session} />
          <Commitment session={session} buyerLabel={buyerLabel} />
          {!terminal ? (
            <ActionArea
              session={session}
              role={role!}
              myMove={myMove}
              keys={keys}
              onKeys={setKeys}
              onAdvance={setSession}
            />
          ) : (
            <TerminalNote session={session} />
          )}
          <EventLedger session={session} />
        </>
      )}
    </div>
  );
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
      // Keep the DEK on this device only; the seller reveals it at step 4.
      saveDek(sessionId, { dek: toB64url(dek), dekSalt: toB64url(dekSalt) });
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
          hash of the key, and signs it. The server stores the commitment and
          your signature, never the data or the key. This bounds and evidences
          cheating; it does not make the trade atomic. The honest ladder is on
          the deal page and in docs/EXCHANGE.md.
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
  chainOk,
  onRefresh,
}: {
  session: SessionView;
  chainOk: boolean;
  onRefresh: () => void;
}) {
  const mover = whoMovesNext(session.state);
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
            title="Recomputed in your browser: every signature and hash-link in the chain."
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
        {terminal ? null : mover ? (
          <span>
            Next move: the{" "}
            <span className="font-mono text-amber">{mover.role}</span>.
          </span>
        ) : null}
      </p>
    </div>
  );
}

function StateChip({ session }: { session: SessionView }) {
  const aborted = session.state === "aborted";
  const done = session.state === "completed";
  const style = aborted
    ? "border-red/50 bg-red-wash text-red"
    : done
      ? "border-green/50 bg-green-wash text-green"
      : "border-amber-soft/50 bg-amber-wash text-amber";
  return (
    <span
      className={[
        "inline-block border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em]",
        style,
      ].join(" ")}
    >
      {stateLabel(session.state)}
    </span>
  );
}

/* -------------------------------------------------------------- ladder */

function Ladder({ session }: { session: SessionView }) {
  const current = rungIndex(session.state);
  const aborted = session.state === "aborted";
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

/* ---------------------------------------------------------- action area */

function ActionArea({
  session,
  role,
  myMove,
  keys,
  onKeys,
  onAdvance,
}: {
  session: SessionView;
  role: ExchangeRole;
  myMove: boolean;
  keys: SigningKeys | null;
  onKeys: (k: SigningKeys) => void;
  onAdvance: (s: SessionView) => void;
}) {
  const mover = whoMovesNext(session.state);

  if (!myMove) {
    return (
      <div className="border border-rule bg-panel-2 px-5 py-4">
        <div className="bt-label">Waiting</div>
        <p className="mt-2 text-[0.8125rem] text-ink-dim">
          It is the{" "}
          <span className="font-mono text-amber">{mover?.role ?? "other party"}</span>&apos;s
          move. This panel updates on its own. You can abort while the trade is
          open.
        </p>
        <div className="mt-3">
          {keys ? (
            <AbortButton session={session} role={role} keys={keys} onAdvance={onAdvance} />
          ) : (
            <UnlockKey viewer={roleUsername(session, role)} onKeys={onKeys} />
          )}
        </div>
      </div>
    );
  }

  const viewer = roleUsername(session, role);
  return (
    <div className="border border-ink/30 bg-panel px-5 py-4">
      <div className="flex items-baseline gap-2">
        <span className="bt-label text-amber">Your move</span>
        <span className="text-[0.75rem] text-ink-faint">
          {RUNGS.find((r) => r.state === nextState(session.state))?.label}
        </span>
      </div>

      {!keys ? (
        <div className="mt-3">
          <UnlockKey viewer={viewer} onKeys={onKeys} />
        </div>
      ) : (
        <div className="mt-3">
          <StepAction session={session} role={role} keys={keys} onAdvance={onAdvance} />
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

/** The commit-copy for the step the mover is about to take. */
function CommitNote({ state }: { state: SessionView["state"] }) {
  const rung = RUNGS.find((r) => r.state === nextState(state));
  if (!rung) return null;
  return (
    <p className="max-w-[68ch] text-[0.8125rem] leading-relaxed text-ink-dim">
      Signing commits you to: <span className="text-ink">{rung.commits}</span>
    </p>
  );
}

/* ------------------------------------------------- per-step actions */

function StepAction({
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
  switch (session.state) {
    case "committed":
      return <VerifyCiphertext session={session} keys={keys} onAdvance={onAdvance} />;
    case "ciphertext_ack":
      return <SignalPayment session={session} keys={keys} onAdvance={onAdvance} />;
    case "payment_signaled":
      return <RevealKey session={session} keys={keys} onAdvance={onAdvance} />;
    case "dek_revealed":
      return <DecryptComplete session={session} keys={keys} onAdvance={onAdvance} />;
    default:
      return null;
  }
}

/** Post a next-step leaf built by the caller, returning the updated session. */
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
      <CommitNote state={session.state} />
      <p className="text-[0.8125rem] text-ink-dim">
        Download the sealed chunks and recompute their Merkle root here. You are
        acknowledging sealed data you cannot open yet.
      </p>
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

function SignalPayment({
  session,
  keys,
  onAdvance,
}: {
  session: SessionView;
  keys: SigningKeys;
  onAdvance: (s: SessionView) => void;
}) {
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("wire");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitShown, setCommitShown] = useState<string | null>(null);

  async function run() {
    if (reference.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const salt = rand(16);
      const commit = paymentCommitHex(salt, reference.trim());
      setCommitShown(commit);
      const posted = await postStep(session, "buyer", keys, "payment_signaled", {
        paymentCommit: commit,
        method,
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
      <CommitNote state={session.state} />
      <p className="text-[0.8125rem] text-ink-dim">
        Pay off-platform, then commit a hash of your payment reference. The
        server stores the hash only, never the reference and never an amount.
        Keep the reference yourself to open the commitment later if needed.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="bt-label">Payment reference (kept on your device)</span>
          <input
            className="bt-input mt-2 max-w-[280px]"
            placeholder="wire confirmation #, tx hash…"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={busy}
          />
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
            <option value="usdc">usdc</option>
            <option value="ach">ach</option>
            <option value="other">other</option>
          </select>
        </label>
      </div>
      {commitShown ? (
        <div className="border border-rule bg-panel-2 px-3 py-2">
          <div className="bt-label">payment commitment</div>
          <div className="mt-1 break-all font-mono text-[0.6875rem] text-amber">{commitShown}</div>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || reference.trim().length === 0}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {busy ? "Signing…" : "Commit payment and sign"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

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
  const stored = loadDek(session.id);

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
        <CommitNote state={session.state} />
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
      <CommitNote state={session.state} />
      <p className="text-[0.8125rem] text-ink-dim">
        Send this key to the buyer directly (the deal room thread, or any private
        channel), then sign the reveal. The server records only that you revealed
        the key matching the committed hash; it never sees the key.
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
      <CommitNote state={session.state} />
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
          ? "The buyer decrypted the dataset and verified it against the committed plaintext root. The signed chain below is the record: both parties' keys took each step, in order. This is evidence, not atomicity: the last mover still chose to move."
          : "The chain stops at the abort. Whoever stopped, and after which step, is provable from the signatures below. That is the bound this protocol buys: not a guarantee of completion, but evidence of who did what."}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- event log */

function EventLedger({ session }: { session: SessionView }) {
  return (
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
  );
}

/* --------------------------------------------------------------- utils */

function roleUsername(session: SessionView, role: ExchangeRole): string {
  return role === "seller" ? session.seller : session.buyer;
}

function nextState(state: SessionView["state"]): SessionView["state"] {
  switch (state) {
    case "committed":
      return "ciphertext_ack";
    case "ciphertext_ack":
      return "payment_signaled";
    case "payment_signaled":
      return "dek_revealed";
    case "dek_revealed":
      return "completed";
    default:
      return state;
  }
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
