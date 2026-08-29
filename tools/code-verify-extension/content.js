/*
 * content.js — the DataBoard Code Verify check, run in the page's origin.
 *
 * This is the trust anchor that lives OUTSIDE the origin: an installed
 * extension, not page-JS grading itself. When the page finishes loading it
 * inventories the scripts and styles the browser actually loaded, hashes them
 * locally with SubtleCrypto, fetches the integrity manifest the site publishes,
 * and asks the PURE decision core (check.js, loaded just before this file in the
 * same isolated world) to check BOTH directions:
 *
 *   forward   every executable/style the page loaded is present in the manifest
 *             at the exact byte hash (nothing extra was injected);
 *   backward  every MANDATORY entrypoint the manifest names was actually
 *             loaded (a stripped-down malicious shell is caught too);
 *   inline    the one stable inline bootstrap matches the pinned hash, and
 *             every other inline script is a recognized RSC flight-data push,
 *             never arbitrary injected code;
 *   pin       the manifest's provenance names the repo + workflow this
 *             extension pins, and the commit is a real 40-hex sha.
 *
 * The judgement lives in check.js (DataBoardCodeVerify.evaluate) so it can be
 * unit-tested off a fixture without a browser; this file is the I/O around it.
 * It reports the result to the background worker, which paints the toolbar badge
 * green or red. The popup shows the detail.
 *
 * WHAT THIS DOES NOT PROVE (see the README and /transparency/code):
 *   - It is DETECTION, not prevention: tampered code can run before this check
 *     flags it. Treat a red badge as "do not trust this session", not "you were
 *     protected".
 *   - It re-fetches same-origin resources with cache:"force-cache" to read the
 *     bytes the browser already has, but a server that serves different bytes
 *     to a fetch than to the original <script> load is a residual gap MV3
 *     cannot fully close without debugger-level response interception.
 *   - It pins the repo + workflow but cannot run `gh attestation verify` in a
 *     browser; the Sigstore signature over the manifest digest is checked by
 *     scripts/verify-served-js.sh --attest. This extension trusts that the
 *     manifest bytes it fetched are the attested ones (a lying manifest is
 *     caught by the CLI, not here).
 */

(() => {
  "use strict";

  // The repo + workflow this build of the extension trusts. A manifest whose
  // provenance names anything else is treated as red: it is not the source
  // this extension was built to verify. Change these only by rebuilding and
  // reinstalling the extension (the honest update channel).
  const PINNED_REPO = "nathanjzhao/databoard";
  const PINNED_WORKFLOW = ".github/workflows/ci.yml";

  const MANIFEST_URL = "/api/transparency/js-manifest";

  async function sha256Hex(buf) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** The manifest path for a /_next/static/ URL, or null if not one. */
  function manifestPathFor(rawUrl, prefix) {
    let pathname;
    try {
      pathname = new URL(rawUrl, location.origin).pathname;
    } catch {
      return null;
    }
    if (!pathname.startsWith(prefix)) return null;
    return pathname.slice(prefix.length);
  }

  async function run() {
    const base = {
      checkedAt: new Date().toISOString(),
      origin: location.origin,
      href: location.href,
    };

    // --- fetch the manifest the site publishes -----------------------------
    let manifest;
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) {
        return report({
          ...base,
          status: "unavailable",
          problems: [`manifest unavailable: ${MANIFEST_URL} returned ${res.status}`],
          ok: [],
          counts: { executables: 0, styles: 0, inline: 0 },
        });
      }
      manifest = await res.json();
    } catch (err) {
      return report({
        ...base,
        status: "unavailable",
        problems: [`could not fetch manifest: ${String(err)}`],
        ok: [],
        counts: { executables: 0, styles: 0, inline: 0 },
      });
    }

    const prefix = (manifest && manifest.prefix) || "/_next/static/";

    // --- inventory + hash what actually loaded (the I/O half) --------------
    const externalScripts = [...document.querySelectorAll("script[src]")]
      .map((el) => el.src)
      .filter((src) => manifestPathFor(src, prefix) !== null);
    const externalStyles = [
      ...document.querySelectorAll('link[rel="stylesheet"][href]'),
    ]
      .map((el) => el.href)
      .filter((href) => manifestPathFor(href, prefix) !== null);

    const loaded = [];
    async function gather(rawUrl, kind) {
      const p = manifestPathFor(rawUrl, prefix);
      try {
        // force-cache reads the copy the browser already fetched for the page,
        // i.e. the bytes that executed, rather than a fresh server round-trip.
        const res = await fetch(rawUrl, { cache: "force-cache" });
        const bytes = await res.arrayBuffer();
        loaded.push({ kind, path: p, sha256: await sha256Hex(bytes) });
      } catch (err) {
        loaded.push({ kind, path: p, sha256: null, error: String(err) });
      }
    }
    for (const s of externalScripts) await gather(s, "script");
    for (const s of externalStyles) await gather(s, "style");

    const inlineScripts = [...document.querySelectorAll("script:not([src])")]
      .map((el) => el.textContent || "")
      .filter((t) => t.length > 0);
    const inline = [];
    for (const text of inlineScripts) {
      inline.push({ text, sha256: await sha256Hex(new TextEncoder().encode(text)) });
    }

    // --- judgement (the pure half, check.js) ------------------------------
    const verdict = DataBoardCodeVerify.evaluate({
      manifest,
      pins: { repo: PINNED_REPO, workflow: PINNED_WORKFLOW },
      loaded,
      inline,
    });
    return report({ ...base, ...verdict });
  }

  function report(result) {
    try {
      chrome.runtime.sendMessage({ type: "code-verify-result", result });
    } catch {
      // The background worker may be asleep; storage below is the fallback.
    }
    try {
      chrome.storage.session.set({ [`result:${location.href}`]: result });
    } catch {
      // session storage unavailable in some contexts; the message path covers it.
    }
  }

  // Kick off after idle so the page's own scripts have loaded and the DOM
  // reflects what actually executed.
  run().catch((err) => {
    report({
      status: "red",
      origin: location.origin,
      href: location.href,
      checkedAt: new Date().toISOString(),
      problems: [`verifier crashed: ${String(err)}`],
      ok: [],
      counts: { executables: 0, styles: 0, inline: 0 },
    });
  });
})();
