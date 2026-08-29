# DataBoard Code Verify (unpacked MV3 extension)

An installed browser extension that independently checks the JavaScript
`getdataboard.vercel.app` runs against the integrity manifest the site
publishes and CI attested. It is the WhatsApp Code Verify model, done for
DataBoard and stated honestly.

The point is that the trust anchor lives **outside the origin**. A web page
cannot securely verify itself when the origin is the adversary: page-JS that
"checks" itself, or a same-origin manifest with no external signature, proves
nothing, because a malicious server serves both the code and its own report
card. So this check runs in an installed extension whose bytes you control,
not in a script the server handed you.

## What it checks

When a page on the pinned origins finishes loading, `content.js` runs in the
page's origin and:

1. **Inventories what actually loaded:** every `<script src>` and
   `<link rel=stylesheet>` under `/_next/static/`, and every inline `<script>`
   in the live DOM.
2. **Fetches the manifest** the site serves at
   `/api/transparency/js-manifest`.
3. **Checks both directions:**
   - *forward*: every loaded executable/style is present in the manifest at
     the exact SHA-256 (hashed locally with SubtleCrypto). Anything loaded that
     is not attested is flagged.
   - *backward*: every **mandatory entrypoint** the manifest names
     (`entrypoints.rootMainFiles` + `polyfillFiles`, the app-shell bootstrap)
     was actually loaded, so a stripped-down malicious shell that simply omits
     code is caught too.
   - *inline*: the one stable inline bootstrap
     (`(self.__next_f=self.__next_f||[]).push([0])`) matches the manifest's
     pinned hash byte-for-byte, and every other inline script is a recognized
     RSC flight-data push (`self.__next_f.push([…])`), which is **data**
     rendered by the already-hashed framework code, never arbitrary injected
     logic. Anything else inline is flagged.
   - *pin*: the manifest's `provenance` names the repo and workflow this
     extension is pinned to (`nathanjzhao/databoard` /
     `.github/workflows/ci.yml`), and `commit` is a real 40-hex sha.
4. **Paints the toolbar badge** green (`OK`) or red (`!`), and the popup shows
   the commit, counts, and every problem or verified item.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this `tools/code-verify-extension/` folder.
4. Visit `https://getdataboard.vercel.app` and reload. The badge shows the
   verdict; click it for detail.

It also runs against a local dev build (`http://localhost/*`,
`http://127.0.0.1/*`) so you can verify a `next start` you built yourself.

## What a green badge does and does not prove

**Does:** the executable and style bytes your browser loaded on this page match,
hash-for-hash, the manifest this deployment published, that manifest names the
pinned repo + workflow, and every mandatory entrypoint was present. If the
served code had been swapped for something not in the manifest, you would see
red.

**Does not:**

- **Detection, not prevention.** The check runs *after* the page's own scripts
  have executed. A red badge means "do not trust this session", not "you were
  protected". Malicious code can act before it is flagged.
- **Re-fetch vs. executed bytes.** MV3 cannot read HTTP response bodies at the
  network layer without debugger-level interception. The extension re-fetches
  each resource with `cache: "force-cache"` to read the copy the browser
  already loaded, but a server that serves different bytes to a fetch than to
  the original `<script>` load is a residual gap this design cannot fully close.
  A determined check pairs this with the CLI below.
- **Manifest trust.** This extension checks bytes against the manifest and pins
  the repo/workflow, but it does not run the Sigstore verification (`gh` does
  not run in a browser). It trusts that the manifest bytes it fetched are the
  attested ones. A **lying manifest** (a server publishing a manifest of its
  own tampered bytes) is caught by `scripts/verify-served-js.sh --attest`,
  which runs `gh attestation verify` over the live manifest against the pinned
  workflow identity. Run that too for the full chain.
- **Reproducibility.** Even the attestation proves only that the CI workflow at
  a repo + commit signed the manifest digest. It does **not** prove the workflow
  faithfully compiled the public source (Next.js is not byte-for-byte
  reproducible in 2026: nondeterministic Server Action ids and per-build secrets
  are baked into the chunks), nor that production serves those bytes. The honest
  residual is written up on `/transparency/code`.
- **Update channel.** You trust the extension's own bytes and its pinned
  repo/workflow. Those change only when you reinstall the unpacked folder, and
  that manual step *is* the trust boundary. There is no auto-update here.

## Files

- `manifest.json`: MV3 manifest (storage permission; the three pinned origins).
- `content.js`: the check, run in the page origin.
- `background.js`: sets the badge, stores per-tab results.
- `popup.html` / `popup.js`: the verdict UI.

The full chain (manifest generation, CI attestation, the transparency-log leaf,
and every honest gap) is documented at `/transparency/code` on the site and in
`docs/code-integrity.md`.
