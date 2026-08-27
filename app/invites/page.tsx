/**
 * /invites
 *
 * The member's invite surface, one column, four blocks: codes, genealogy,
 * the referral ledger (downline), and the mirror (what the viewer owes up
 * their own chain). Everything money-shaped on this page is a RECORD: the
 * platform computes accruals at read time and holds nothing; settlement
 * happens between the two accounts, off the platform, and gets written down
 * here two-sidedly. The one enforcement is privilege-gating: an account 60+
 * days behind cannot post asks or record deals until it settles or disputes.
 *
 * Genealogy visibility, stated where it is rendered: who invited whom is
 * shown only to the two accounts on each edge and to operators. It is never
 * public, and /transparency documents that choice.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { timeAgo } from "@/components/matches/format";
import { depthLabel, rateLabel, usdWhole } from "@/components/invites/format";
import {
  CopyCodeButton,
  MintInviteButton,
} from "@/components/invites/code-controls";
import {
  ConfirmSettlementButton,
  DisputeButton,
  RecordSettlementForm,
} from "@/components/invites/ledger-controls";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import {
  MAX_STANDING_INVITE_BONUS,
  maxUnusedInvites,
  invitedBy,
  listInvitees,
  listInvitesFor,
} from "@/lib/invites";
import { isOperator } from "@/lib/moderation";
import { recordedVolumeByUser } from "@/lib/stats";
import { recorderStanding, TRUSTED_RECORDER_MIN_TIER } from "@/lib/matching";
import {
  MAX_REFERRAL_DEPTH,
  TIMELY_EVIDENCE_CREDIT_BPS,
  computeReferralLedger,
  houseFloorReceivables,
  listOpenDisputes,
  settlementStanding,
  structureSignalsFor,
  type StructureFlags,
} from "@/lib/referrals";

export const metadata: Metadata = { title: "Invites" };
export const dynamic = "force-dynamic";

const EYEBROW = "Invites";
const TITLE = "Who vouched, who owes whom.";
const BLURB =
  "Nobody joins without a member's code, so every account hangs off a chain " +
  "of vouches. That chain carries a fee: 2.5% of your board-recorded " +
  "earnings to your inviter, 2.5% of that to theirs, six steps at most. The " +
  "board computes and records; it holds and moves no money.";

export default async function InvitesPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const [
    codes,
    inviter,
    invitees,
    ledger,
    standing,
    operator,
    signals,
    houseReceivables,
    volumes,
  ] = await Promise.all([
    listInvitesFor(user.id),
    invitedBy(user.id),
    listInvitees(user.id),
    computeReferralLedger(user.id),
    settlementStanding(user.id),
    isOperator(user.id),
    structureSignalsFor(user.id),
    houseFloorReceivables(user.id),
    recordedVolumeByUser([user.id]),
  ]);
  const disputes = operator ? await listOpenDisputes() : [];
  const unusedCount = codes.filter((c) => !c.usedByUsername).length;

  // Recorder standing (feature C): the compact status, the invite cap, and the
  // trusted-recorder threshold all read the same confirmed, evidenced recorded
  // volume the referral fee accrues on.
  const vol = volumes.get(user.id);
  const recStanding = recorderStanding(vol?.volumeUsd ?? 0, vol?.evidenceBackedDeals ?? 0);
  const inviteCap = maxUnusedInvites(recStanding.tier);

  // Timely-recording credit earned so far (feature A): the sum of what the
  // credit knocked off across the viewer's whole chain.
  const totalCreditedCents = ledger.upline.reduce((s, u) => s + u.creditedCents, 0);
  const creditPct = Math.round(TIMELY_EVIDENCE_CREDIT_BPS / 100);

  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-14">
      <div className="bt-label">{EYEBROW}</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        {TITLE}
      </h1>
      <p className="mt-4 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        {BLURB}
      </p>

      {/* ------------------------------------------ recorder standing (C) */}
      <div className="mt-8 border border-rule bg-panel px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="bt-label">Recorder standing</div>
          <span
            className={[
              "border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.1em]",
              recStanding.trusted
                ? "border-green/50 bg-green-wash text-green"
                : recStanding.tier > 0
                  ? "border-rule-strong text-ink-dim"
                  : "border-rule text-ink-faint",
            ].join(" ")}
          >
            {recStanding.label}
          </span>
        </div>
        <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Your confirmed, evidenced recorded volume, bucketed. It is the same
          volume the referral fee accrues on, so standing is never free: the
          volume that unlocks a benefit is the volume that paid. Exact figures
          stay on the server; only the tier and the bucket show.
        </p>
        <dl className="mt-3.5 grid grid-cols-2 gap-x-8 gap-y-3 border-t border-rule pt-3.5 sm:grid-cols-4">
          <StandingCell label="Tier">
            {recStanding.tier} of {TRUSTED_RECORDER_MIN_TIER + 2}
          </StandingCell>
          <StandingCell label="Recorded volume">{recStanding.chip ?? "none"}</StandingCell>
          <StandingCell label="Match priority">
            {recStanding.tier > 0 ? `+${recStanding.tier}` : "base"}
          </StandingCell>
          <StandingCell label="Invite cap">
            {inviteCap}
            {recStanding.tier > 0 ? (
              <span className="text-ink-faint"> (+{inviteCap - 5})</span>
            ) : null}
          </StandingCell>
        </dl>
        <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
          {recStanding.trusted
            ? "Trusted recorder: your asks wear the badge, and you sit at the top matching-priority tier."
            : `Clear tier ${TRUSTED_RECORDER_MIN_TIER} to wear the trusted-recorder badge on your asks. Every tier also adds an unused-invite slot, up to +${MAX_STANDING_INVITE_BONUS}.`}
        </p>
      </div>

      {standing.behind ? (
        <div className="mt-8 border-l-2 border-red bg-red-wash px-4 py-3.5">
          <div className="bt-label text-red">Behind on referral obligations</div>
          <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
            Some of what you owe up your chain has been outstanding for more
            than 60 days. Until it is settled or disputed, this account cannot
            post new asks or record new deals. Settle by paying the person and
            having them record it below, or dispute the pair to put it in
            front of an operator.
          </p>
          <ul className="mt-2 space-y-1 font-mono text-[0.75rem] text-ink">
            {standing.pairs.map((p) => (
              <li key={p.payeeUsername}>
                @{p.payeeUsername}: {usdWhole(p.outstandingCents)} outstanding,
                oldest {timeAgo(p.oldestUnsettledAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------------------------------- codes */}
      <section className="mt-12 border-t border-rule pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="bt-display text-[1.5rem] text-ink">Your codes</h2>
          <span className="font-mono text-[0.6875rem] text-ink-faint">
            {operator
              ? `${unusedCount} unused, uncapped (operator)`
              : `${unusedCount} of ${inviteCap} unused slots held`}
          </span>
        </div>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          A code admits exactly one account and records you as its voucher,
          permanently.{" "}
          {operator
            ? "As an operator you are uncapped."
            : `Mint at most ${inviteCap} unused at a time` +
              (recStanding.tier > 0
                ? ` (base 5, plus ${inviteCap - 5} for your recorder standing)`
                : "") +
              "; hand them to people you would answer for."}
        </p>
        <div className="mt-4">
          <MintInviteButton />
        </div>
        <div className="mt-4 border border-rule bg-panel">
          {codes.length === 0 ? (
            <p className="px-4 py-4 text-[0.8125rem] text-ink-faint">
              No codes minted yet.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {codes.map((c) => (
                <li
                  key={c.code}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <span className="break-all font-mono text-[0.8125rem] text-ink">
                    {c.code}
                  </span>
                  {!c.usedByUsername ? <CopyCodeButton code={c.code} /> : null}
                  <span className="ml-auto font-mono text-[0.6875rem] text-ink-faint">
                    {c.usedByUsername
                      ? `used by @${c.usedByUsername} ${c.usedAt ? timeAgo(c.usedAt) : ""}`
                      : `unused, minted ${timeAgo(c.createdAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* --------------------------------------------------- genealogy */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="bt-display text-[1.5rem] text-ink">Your chain</h2>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Who invited whom is stored, and it is visible exactly here: to the
          two accounts on each edge, and to operators. It appears on no
          public surface, the leaderboard included.
        </p>
        <div className="mt-4 border border-rule bg-panel">
          <div className="border-b border-rule px-4 py-3 text-[0.8125rem] text-ink-dim">
            {inviter ? (
              <>
                Invited by <span className="font-mono text-ink">@{inviter.username}</span>{" "}
                <span className="font-mono text-[0.6875rem] text-ink-faint">
                  {timeAgo(inviter.at)}
                </span>
              </>
            ) : (
              <>This account predates invites. Nobody is recorded above you.</>
            )}
          </div>
          {invitees.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-ink-faint">
              Nobody has joined on your codes yet.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {invitees.map((i) => (
                <li
                  key={i.username}
                  className="flex items-baseline gap-3 px-4 py-2.5"
                >
                  <span className="font-mono text-[0.8125rem] text-ink">
                    @{i.username}
                  </span>
                  <span className="ml-auto font-mono text-[0.6875rem] text-ink-faint">
                    joined {timeAgo(i.joinedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ ledger */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="bt-display text-[1.5rem] text-ink">
          Accruing to you
        </h2>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Everyone beneath you within {MAX_REFERRAL_DEPTH} steps, and what
          their earnings accrue to you: 2.5% per step, on confirmed shares of
          co-attested deals only. Solo claims accrue nothing. When someone
          pays you off the platform, record it on their row; your record is
          what reduces the debt.
        </p>
        <div className="mt-4 border border-rule bg-panel">
          {ledger.downline.length === 0 ? (
            <p className="px-4 py-4 text-[0.8125rem] text-ink-faint">
              Nobody in your downline yet. Accruals start when someone who
              joined on your chain records earnings.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="bt-label px-4 py-2.5 font-normal">member</th>
                    <th className="bt-label px-2 py-2.5 font-normal">depth / rate</th>
                    <th className="bt-label px-2 py-2.5 text-right font-normal">earnings</th>
                    <th className="bt-label px-2 py-2.5 text-right font-normal">accrued</th>
                    <th className="bt-label px-2 py-2.5 text-right font-normal">settled</th>
                    <th className="bt-label px-2 py-2.5 text-right font-normal">outstanding</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {ledger.downline.map((d) => (
                    <tr key={d.username} className="align-top">
                      <td className="px-4 py-3 font-mono text-ink">
                        @{d.username}
                        {d.disputed ? (
                          <span className="ml-2 bg-red-wash px-1.5 py-0.5 font-mono text-[0.625rem] text-red">
                            disputed
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 font-mono text-[0.6875rem] text-ink-faint">
                        {depthLabel(d.depth)} · {rateLabel(d.depth)}
                      </td>
                      <td className="px-2 py-3 text-right font-mono tabular-nums text-ink-dim">
                        {usdWhole(d.lifetimeEarningsCents)}
                      </td>
                      <td className="px-2 py-3 text-right font-mono tabular-nums text-ink">
                        {usdWhole(d.accruedCents)}
                      </td>
                      <td className="px-2 py-3 text-right font-mono tabular-nums text-ink-dim">
                        {usdWhole(d.settledCents)}
                      </td>
                      <td className="px-2 py-3 text-right font-mono tabular-nums text-ink">
                        {usdWhole(d.outstandingCents)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <RecordSettlementForm payerUsername={d.username} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ mirror */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="bt-display text-[1.5rem] text-ink">
          What you owe up your chain
        </h2>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          The same arithmetic from the other side: each ancestor, their rate
          on your earnings, and where you stand. You pay them directly, off
          the platform; they record it; you confirm. If a figure is wrong,
          dispute the pair; that lifts any block and puts it in front of an
          operator.
        </p>
        <div className="mt-3 border-l-2 border-green/50 bg-green-wash/40 px-4 py-3">
          <div className="bt-label text-green">Timely-recording credit</div>
          <p className="mt-1.5 max-w-[64ch] text-[0.75rem] leading-relaxed text-ink-faint">
            A confirmed share earns a {creditPct}% cut of the referral it owes,
            at every step, when the deal was recorded within two weeks of the
            close date you stated and you committed evidence on your row. The
            credit only lowers what you owe, never below zero; a deal with no
            stated close date or no evidence earns nothing.
            {totalCreditedCents > 0 ? (
              <>
                {" "}
                So far it has knocked{" "}
                <span className="font-mono text-green">{usdWhole(totalCreditedCents)}</span>{" "}
                off what you owe up your chain.
              </>
            ) : null}
          </p>
        </div>
        <div className="mt-4 border border-rule bg-panel">
          {ledger.upline.length === 0 ? (
            <p className="px-4 py-4 text-[0.8125rem] text-ink-faint">
              No ancestors recorded. Nothing accrues from your earnings.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {ledger.upline.map((a) => (
                <li key={a.username} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-mono text-[0.8125rem] text-ink">
                      @{a.username}
                    </span>
                    <span className="font-mono text-[0.6875rem] text-ink-faint">
                      {a.isHouse ? "house floor" : depthLabel(a.depth)} ·{" "}
                      {rateLabel(a.depth)} of your earnings
                    </span>
                    {a.disputed ? (
                      <span className="bg-red-wash px-1.5 py-0.5 font-mono text-[0.625rem] text-red">
                        disputed
                      </span>
                    ) : (
                      <DisputeButton withUsername={a.username} />
                    )}
                    <span className="ml-auto font-mono text-[0.75rem] tabular-nums text-ink">
                      {usdWhole(a.accruedCents)} accrued · {usdWhole(a.settledCents)}{" "}
                      settled · {usdWhole(a.outstandingCents)} outstanding
                    </span>
                  </div>
                  {a.oldestUnsettledAt != null ? (
                    <p className="mt-1 font-mono text-[0.6875rem] text-ink-faint">
                      oldest unsettled accrual {timeAgo(a.oldestUnsettledAt)}
                    </p>
                  ) : null}
                  {a.creditedCents > 0 ? (
                    <p className="mt-1 font-mono text-[0.6875rem] text-green">
                      timely-recording credit −{usdWhole(a.creditedCents)}
                    </p>
                  ) : null}
                  {a.settlements.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {a.settlements.map((s) => (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-dim"
                        >
                          <span className="font-mono tabular-nums">
                            {usdWhole(s.amountCents)}
                          </span>
                          <span className="font-mono text-[0.6875rem] text-ink-faint">
                            recorded {timeAgo(s.settledAt)}
                          </span>
                          {s.note ? <span>{s.note}</span> : null}
                          {s.confirmedByPayer ? (
                            <span className="font-mono text-[0.6875rem] text-green">
                              confirmed by you
                            </span>
                          ) : (
                            <ConfirmSettlementButton settlementId={s.id} />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ------------------------------------------------ house floor */}
      {houseReceivables.length > 0 ? (
        <section className="mt-12 border-t border-rule pt-8">
          <h2 className="bt-display text-[1.5rem] text-ink">
            House floor
            <span className="ml-3 bt-token align-middle">operator view</span>
          </h2>
          <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            Accounts with nobody recorded above them still owe the first step,
            2.5%, on their confirmed earnings. They are not in anyone&apos;s
            downline, so the floor lands here, on the house. Record a payment on
            a member&apos;s row when they settle it off the platform.
          </p>
          <div className="mt-4 overflow-x-auto border border-rule bg-panel">
            <table className="w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-rule">
                  <th className="bt-label px-4 py-2.5 font-normal">member</th>
                  <th className="bt-label px-2 py-2.5 text-right font-normal">earnings</th>
                  <th className="bt-label px-2 py-2.5 text-right font-normal">accrued</th>
                  <th className="bt-label px-2 py-2.5 text-right font-normal">settled</th>
                  <th className="bt-label px-2 py-2.5 text-right font-normal">outstanding</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {houseReceivables.map((h) => (
                  <tr key={h.username} className="align-top">
                    <td className="px-4 py-3 font-mono text-ink">
                      @{h.username}
                      {h.disputed ? (
                        <span className="ml-2 bg-red-wash px-1.5 py-0.5 font-mono text-[0.625rem] text-red">
                          disputed
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums text-ink-dim">
                      {usdWhole(h.lifetimeEarningsCents)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums text-ink">
                      {usdWhole(h.accruedCents)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums text-ink-dim">
                      {usdWhole(h.settledCents)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums text-ink">
                      {usdWhole(h.outstandingCents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RecordSettlementForm payerUsername={h.username} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* --------------------------------------------- structure signals */}
      {signals.self.reportedDeals > 0 || signals.downline.length > 0 ? (
        <section className="mt-12 border-t border-rule pt-8">
          <h2 className="bt-display text-[1.5rem] text-ink">Structure signals</h2>
          <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            Metadata only, no dollars and no buyer names: read-outs on how the
            deals you report are shaped, and the same for everyone whose
            earnings accrue to you. High unallocated value or a run of
            never-confirming counterparties is what routing around the fee looks
            like. These are signals for a human to read, not automatic penalties.
          </p>
          <div className="mt-4 space-y-px border border-rule bg-rule">
            {signals.self.reportedDeals > 0 ? (
              <SignalRow label="you" flags={signals.self} />
            ) : null}
            {signals.downline.map((f) => (
              <SignalRow key={f.username} label={`@${f.username}`} flags={f} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------- the honest print */}
      <section className="mt-12 border-t border-rule pt-8">
        <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
          <div className="bt-label text-amber">What this ledger is</div>
          <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
            A computation and a record. The platform derives every figure above
            from the invite chain and the deals ledger at read time, holds no
            balances, and moves no money; settlement happens between the two of
            you, on rails you choose. The obligation itself is a term of
            service (
            <Link href="/terms#referrals" className="text-blue hover:text-amber">
              /terms
            </Link>
            , section 08), enforced today by privilege-gating only. At-source
            deduction, where the fee comes out before money reaches the earner,
            is the planned Stripe Connect upgrade described in the payments
            blueprint; it is not shipped, and nothing here pretends otherwise.
          </p>
        </div>
      </section>

      {operator && disputes.length > 0 ? (
        <section className="mt-12 border-t border-rule pt-8">
          <h2 className="bt-display text-[1.5rem] text-ink">
            Open disputes
            <span className="ml-3 bt-token align-middle">operator view</span>
          </h2>
          <ul className="mt-4 divide-y divide-rule border border-rule bg-panel">
            {disputes.map((d) => (
              <li
                key={`${d.payerUsername}-${d.payeeUsername}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[0.8125rem]"
              >
                <span className="font-mono text-ink">
                  @{d.payerUsername} owes @{d.payeeUsername}
                </span>
                <span className="text-ink-faint">
                  raised by <span className="font-mono">@{d.raisedByUsername}</span>
                </span>
                <span className="ml-auto font-mono text-[0.6875rem] text-ink-faint">
                  {timeAgo(d.raisedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One cell of the compact recorder-standing status. */
function StandingCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="bt-label">{label}</dt>
      <dd className="font-mono text-[0.8125rem] tabular-nums text-ink">{children}</dd>
    </div>
  );
}

/** One account's structure signals: metadata counts, no dollars. */
function SignalRow({ label, flags }: { label: string; flags: StructureFlags }) {
  const pct = Math.round(flags.unallocatedRatioBps / 100);
  const highUnallocated = flags.unallocatedRatioBps >= 5000;
  const hasChronic = flags.chronicallyPendingCounterparties > 0;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-panel px-4 py-3 text-[0.75rem]">
      <span className="font-mono text-[0.8125rem] text-ink">{label}</span>
      <span className="text-ink-faint">
        {flags.reportedDeals} reported
      </span>
      <span className={highUnallocated ? "text-amber" : "text-ink-faint"}>
        {pct}% unallocated
      </span>
      <span className="text-ink-faint">{flags.exactSplitDeals} exact splits</span>
      <span className={hasChronic ? "text-amber" : "text-ink-faint"}>
        {flags.chronicallyPendingCounterparties} never-confirmed
      </span>
    </div>
  );
}
