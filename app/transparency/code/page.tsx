/**
 * /transparency/code
 *
 * The served-JS integrity story, publicly reachable like the rest of
 * /transparency (lib/gate.ts serves the /transparency/ prefix without a
 * session). One page, one job: document the whole chain from a commit to the
 * bytes your browser runs, and state the residual honestly. Every claim here is
 * either running or labeled with exactly what it does not cover.
 *
 * NB (writing): no em-dashes in this file's rendered copy; it is public UI.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { TSection } from "@/components/transparency/section";

export const metadata: Metadata = {
  title: "Code integrity",
  description:
    "How you can check that the JavaScript this site runs matches a manifest CI attested, and the honest residual: reproducibility, detection not prevention, and who you still trust.",
};

const REPO = "https://github.com/nathanjzhao/databoard";
const CONTENTS = [
  ["01", "anchor", "The trust anchor"],
  ["02", "manifest", "The manifest"],
  ["03", "attestation", "The attestation"],
  ["04", "log", "In the log"],
  ["05", "verify", "The installed verifier"],
  ["06", "residual", "The honest residual"],
] as const;

export default function CodeIntegrityPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-14">
      <div className="bt-label">
        <Link href="/transparency" className="hover:text-ink">
          Transparency
        </Link>{" "}
        · Code integrity
      </div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        Check the JavaScript we serve you.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        The rest of transparency is about what we store. This is about the code
        itself: the JavaScript your browser downloads and runs when you use the
        board. You do not have to take our word that it is the code in the
        public repo. You can check the bytes, with a tool that does not come
        from us. Here is the whole chain, and the exact point past which you are
        still trusting someone.
      </p>

      <nav className="mt-8 flex gap-x-6 gap-y-2 overflow-x-auto border-y border-rule py-3">
        {CONTENTS.map(([num, id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="group flex shrink-0 items-baseline gap-2 text-[0.8125rem] text-ink-dim transition-colors hover:text-ink"
          >
            <span className="bt-token">{num}</span>
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="mt-10 space-y-14">
        <TSection
          id="anchor"
          num="01"
          title="The trust anchor lives outside the origin"
          lede="The first thing to be honest about: a web page cannot securely verify itself when the origin is the adversary. If a malicious server can serve you the code, it can serve you the script that 'checks' the code and a manifest of its own lies. Page-JS grading itself proves nothing."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            So the checker cannot be something we hand you. It has to be a tool
            whose bytes you control: an installed browser extension, or a command
            you run in your own terminal. That is the whole design principle
            here. Everything below produces evidence; the thing that grades the
            evidence is outside this origin, in{" "}
            <span className="font-mono text-[0.75rem]">tools/code-verify-extension</span>{" "}
            and{" "}
            <span className="font-mono text-[0.75rem]">scripts/verify-served-js.sh</span>,
            which you install and run yourself.
          </p>
          <p className="mt-3 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            One more honest frame before the mechanics: this is detection, not
            prevention. The check runs after the page has already loaded its
            scripts. A red result tells you not to trust this session. It does
            not mean you were shielded from code that already ran. That is the
            same limit WhatsApp&apos;s Code Verify carries, and it is real.
          </p>
        </TSection>

        <TSection
          id="manifest"
          num="02"
          title="A manifest of every byte we serve"
          lede="Right after the production build, CI hashes every executable and style asset the deployment will serve and writes a canonical manifest. The site publishes that manifest at a public endpoint, so a verifier can compare the bytes it loaded against it."
        >
          <div className="border border-rule bg-panel px-5 py-4">
            <div className="bt-label">What the manifest covers</div>
            <ul className="mt-2 space-y-1.5 text-[0.8438rem] leading-relaxed text-ink-dim">
              <li>
                <span className="font-mono text-[0.75rem]">files</span>: every
                file under{" "}
                <span className="font-mono text-[0.75rem]">.next/static</span>{" "}
                (the{" "}
                <span className="font-mono text-[0.75rem]">/_next/static/</span>{" "}
                surface): all JS chunks, the CSS, media, and the per-build
                manifests, each with its SHA-256 and byte count.
              </li>
              <li>
                <span className="font-mono text-[0.75rem]">entrypoints</span>:
                the mandatory app-shell bootstrap chunks, so a verifier can
                check not only that nothing extra loaded but that nothing
                required was quietly dropped.
              </li>
              <li>
                <span className="font-mono text-[0.75rem]">inline</span>: the one
                stable inline bootstrap Next injects on every page, with its
                hash. The other inline script on a page is the per-request React
                Server Component payload, which is data rendered by the hashed
                framework code, recognized by prefix rather than pinned.
              </li>
              <li>
                <span className="font-mono text-[0.75rem]">commit</span> and{" "}
                <span className="font-mono text-[0.75rem]">buildId</span>: the
                git commit this build came from. We pin the build id to that
                commit (
                <span className="font-mono text-[0.75rem]">generateBuildId</span>{" "}
                in{" "}
                <span className="font-mono text-[0.75rem]">next.config.ts</span>),
                so the static path names are the commit, not a fresh random
                string, removing one source of build-to-build drift.
              </li>
              <li>
                <span className="font-mono text-[0.75rem]">provenance</span>: the
                repo, workflow, and the exact command to verify the attestation
                below.
              </li>
            </ul>
          </div>
          <p className="mt-4 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            It is served at{" "}
            <a
              href="/api/transparency/js-manifest"
              className="font-mono text-blue hover:text-amber"
            >
              /api/transparency/js-manifest
            </a>
            . The generator is{" "}
            <span className="font-mono text-[0.75rem]">
              scripts/gen-js-manifest.mjs
            </span>
            .
          </p>
        </TSection>

        <TSection
          id="attestation"
          num="03"
          title="CI signs the manifest with Sigstore"
          lede="A manifest the same server publishes is not yet third-party: a lying server could publish a manifest of its own tampered bytes. So CI binds the manifest's digest to its own identity."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            After the build, the CI workflow attests the manifest&apos;s SHA-256
            with{" "}
            <span className="font-mono text-[0.75rem]">
              actions/attest-build-provenance
            </span>
            , which signs through Sigstore and records SLSA build provenance. The
            manifest and the signature bundle are published as workflow
            artifacts. Anyone can then verify the manifest the live site serves:
          </p>
          <pre className="mt-4 overflow-x-auto border border-rule bg-panel px-4 py-3 font-mono text-[0.75rem] leading-relaxed text-ink">
            {`gh attestation verify <manifest.json> \\
  --repo nathanjzhao/databoard \\
  --signer-workflow nathanjzhao/databoard/.github/workflows/ci.yml`}
          </pre>
          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            <span className="font-mono text-[0.75rem]">
              scripts/verify-served-js.sh --attest
            </span>{" "}
            runs exactly this against a live deployment, then hashes sample live
            assets against the same manifest.
          </p>
          <div className="mt-5 border-l-2 border-amber bg-amber-wash px-4 py-3.5">
            <div className="bt-label text-amber">What the signature proves, precisely</div>
            <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              It proves that the CI workflow identity, at this repo and this
              commit, signed this manifest digest. That is worth stating exactly
              because it is narrower than it sounds. It does not prove the
              workflow faithfully compiled the public source, and it does not
              prove production is serving those bytes. Its force is that you are
              now trusting, and constraining, a named GitHub workflow instead of
              an anonymous server. Tying the digest to the bytes your browser
              actually ran is the verifier&apos;s job, in section 05.
            </p>
          </div>
        </TSection>

        <TSection
          id="log"
          num="04"
          title="The manifest goes into the append-only log"
          lede="The manifest digest is also written as a leaf in the transparency log, so which JavaScript a deployment vouched for at a commit is as tamper-evident as the deal ledger."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            A{" "}
            <span className="font-mono text-[0.75rem]">served_manifest</span>{" "}
            leaf records the manifest&apos;s SHA-256, the build id, and the
            commit. Because it lives in the same RFC 6962 Merkle log as
            everything else (
            <Link href="/transparency/log" className="text-blue hover:text-amber">
              /transparency/log
            </Link>
            ), it inherits the same property: an operator cannot quietly swap
            which JavaScript it vouched for at a commit without the log&apos;s
            consistency proof and the external anchors disagreeing. The hook is{" "}
            <span className="font-mono text-[0.75rem]">
              scripts/log-served-manifest.ts
            </span>
            , run at deploy against the deployment&apos;s own database. All three
            fields are public and non-PII: a commit, a build id, and a hash.
          </p>
        </TSection>

        <TSection
          id="verify"
          num="05"
          title="The installed verifier ties it to your browser"
          lede="This is the anchor from section 01, made concrete. Two forms, both outside this origin, both checking the bytes that actually ran."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="border border-rule bg-panel px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.875rem] font-medium text-ink">
                  Browser extension
                </span>
                <span className="inline-block border border-rule-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-faint">
                  MV3 · unpacked
                </span>
              </div>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
                Install{" "}
                <span className="font-mono text-[0.7rem]">
                  tools/code-verify-extension
                </span>{" "}
                unpacked. When a page loads it inventories the scripts and styles
                the browser ran, hashes them locally, fetches the manifest, and
                checks both directions: every loaded executable is attested, and
                every mandatory entrypoint was present. It pins the repo and
                workflow, and paints the toolbar badge green or red.
              </p>
            </div>
            <div className="border border-rule bg-panel px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.875rem] font-medium text-ink">
                  Terminal script
                </span>
                <span className="inline-block border border-rule-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-faint">
                  gh + curl
                </span>
              </div>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
                <span className="font-mono text-[0.7rem]">
                  scripts/verify-served-js.sh &lt;url&gt; --attest
                </span>{" "}
                verifies the Sigstore attestation over the live manifest against
                the pinned workflow, then fetches live assets and checks their
                SHA-256 against it. Without{" "}
                <span className="font-mono text-[0.7rem]">--attest</span> it does
                the byte check alone, which needs no GitHub account.
              </p>
            </div>
          </div>
          <p className="mt-4 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            The extension observes the bytes the browser loaded (it re-reads them
            from cache); the script checks the CI attestation the extension
            cannot. Run both for the full chain. Install notes and the complete
            limit list are in{" "}
            <a
              href={`${REPO}/tree/main/tools/code-verify-extension`}
              className="font-mono text-blue hover:text-amber"
            >
              tools/code-verify-extension/README.md
            </a>
            .
          </p>
        </TSection>

        <TSection
          id="residual"
          num="06"
          title="The honest residual"
          lede="What you are still trusting after all of the above, named rather than hidden. None of these is a bug; each is a real limit of what this kind of verification can do in 2026."
        >
          <ul className="space-y-3">
            <li className="border-l-2 border-red bg-red-wash px-4 py-3.5">
              <div className="bt-label text-red">Detection, not prevention</div>
              <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                The verifier runs after the page&apos;s scripts have executed.
                Tampered code can act before the badge turns red. Treat a red
                badge as a reason to stop and distrust the session, not as proof
                you were protected in it.
              </p>
            </li>
            <li className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
              <div className="bt-label text-amber">The reproducibility gap</div>
              <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                Next.js is not byte-for-byte reproducible in 2026: it bakes
                nondeterministic Server Action ids and per-build secrets into the
                chunks, so two independent builds of the same commit do not
                produce identical bytes. Pinning the build id to the commit
                removes one source of drift but not this one. So the achievable
                claim is precise: the served bytes match a manifest that CI
                attested was built by this workflow from this commit. It is not a
                claim that these bytes provably came from the public source by an
                independent rebuild. That stronger claim needs reproducible
                builds we do not have yet.
              </p>
            </li>
            <li className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
              <div className="bt-label text-amber">
                Trust in CI, Sigstore, and GitHub
              </div>
              <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                The attestation proves a GitHub workflow signed the manifest
                digest. You are trusting that GitHub ran the workflow it says it
                ran, that Sigstore&apos;s roots are honest, and that the workflow
                definition in the repo is the one that ran. This moves trust from
                an anonymous server to a named, public, constrained builder,
                which is a real improvement and an honest cost, not zero trust.
              </p>
            </li>
            <li className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
              <div className="bt-label text-amber">Re-fetch versus executed bytes</div>
              <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                A browser extension under MV3 cannot read raw HTTP response
                bodies without debugger-level interception, so the extension
                re-reads each resource from the browser cache to approximate the
                bytes that executed. A server that served different bytes to that
                read than to the original script load is a gap this form cannot
                fully close on its own; pairing it with the terminal script,
                which pulls assets fresh and checks the attestation, is the
                answer.
              </p>
            </li>
            <li className="border-l-2 border-rule-strong bg-panel px-4 py-3.5">
              <div className="bt-label">The extension&apos;s own update channel</div>
              <p className="mt-2 max-w-[64ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                The verifier is only as trustworthy as its own bytes and the repo
                and workflow it pins. It is shipped unpacked and has no
                auto-update: those pins change only when you reinstall the folder
                yourself. That manual step is the trust boundary, on purpose, and
                it is the last link in the chain that stays in your hands.
              </p>
            </li>
          </ul>
          <p className="mt-6 text-[0.8125rem] leading-relaxed text-ink-faint">
            Back to{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              the transparency overview
            </Link>
            , or the{" "}
            <Link href="/transparency/log" className="text-blue hover:text-amber">
              append-only log
            </Link>
            .
          </p>
        </TSection>
      </div>
    </div>
  );
}
