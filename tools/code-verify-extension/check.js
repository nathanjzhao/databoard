/*
 * check.js — the PURE decision core of the DataBoard Code Verify check.
 *
 * content.js does the I/O: it inventories the scripts and styles the browser
 * actually loaded, hashes their bytes with SubtleCrypto, and fetches the
 * manifest. This module does the JUDGEMENT: given the manifest the site
 * published and that already-hashed inventory, it decides green/red and lists
 * every problem, in the same order and with the same messages the check used to
 * emit inline. Keeping the judgement here, with no DOM / fetch / crypto, is what
 * makes it testable off a fixture (tests/verifiable.spec.ts, case JS-3) instead
 * of only through a live browser.
 *
 * It loads two ways from one file:
 *   - as an MV3 content script (declared before content.js in manifest.json),
 *     it runs in the same isolated world and sets globalThis.DataBoardCodeVerify;
 *   - as a CommonJS module under node, `require("./check.js")` returns the same
 *     { evaluate } (the test imports it this way).
 *
 * evaluate(input) input shape:
 *   {
 *     manifest,                       // the parsed /api/transparency/js-manifest
 *     pins: { repo, workflow },       // what THIS extension build trusts
 *     loaded: [                       // one per external /_next/static resource
 *       { kind: "script"|"style", path, sha256, error? }  // path manifest-relative,
 *     ],                              //   sha256 = hex of the bytes that executed
 *     inline: [ { sha256, text } ],   // one per non-empty inline <script>
 *   }
 * It returns { status, manifest, commit, buildId, counts, problems, ok }, with
 * status "green" (no problems), "red" (problems), or "unavailable" (no manifest).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DataBoardCodeVerify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function evaluate(input) {
    input = input || {};
    var manifest = input.manifest;
    var pins = input.pins || {};
    var loaded = input.loaded || [];
    var inline = input.inline || [];

    var result = {
      status: "red",
      manifest: null,
      commit: null,
      buildId: null,
      counts: { executables: 0, styles: 0, inline: inline.length },
      problems: [],
      ok: [],
    };

    // No manifest (or a stub with no files array) is not a red verdict about the
    // page, it is "cannot check": say so, the way content.js does on a 503.
    if (!manifest || !Array.isArray(manifest.files)) {
      result.status = "unavailable";
      result.problems.push("manifest has no files array (a stub or not built)");
      return result;
    }

    result.manifest = {
      version: manifest.version,
      file_count: manifest.file_count,
      generated_at: manifest.generated_at,
    };
    result.commit = manifest.commit || null;
    result.buildId = manifest.buildId || null;

    var byPath = new Map();
    var knownHashes = new Set();
    for (var i = 0; i < manifest.files.length; i++) {
      var f = manifest.files[i];
      byPath.set(f.path, f);
      knownHashes.add(f.sha256);
    }

    // --- pin: is this manifest from the source we trust? -------------------
    var prov = manifest.provenance || {};
    if (prov.repo !== pins.repo || prov.workflow !== pins.workflow) {
      result.problems.push(
        "provenance mismatch: manifest names " +
          (prov.repo || "?") +
          " / " +
          (prov.workflow || "?") +
          ", this extension pins " +
          pins.repo +
          " / " +
          pins.workflow,
      );
    } else {
      result.ok.push("provenance pinned to " + pins.repo + " / " + pins.workflow);
    }
    if (!/^[0-9a-f]{40}$/.test(result.commit || "")) {
      result.problems.push("commit is not a 40-hex sha: " + (result.commit || "(none)"));
    }

    // --- forward: every loaded executable/style must be in the manifest ----
    var loadedPaths = new Set();
    var executables = 0;
    var styles = 0;
    for (var j = 0; j < loaded.length; j++) {
      var item = loaded[j];
      var kind = item.kind === "style" ? "style" : "script";
      if (kind === "style") styles++;
      else executables++;
      var p = item.path;
      loadedPaths.add(p);
      var entry = byPath.get(p);
      if (!entry) {
        result.problems.push(kind + " not in manifest: " + p);
        continue;
      }
      if (item.error) {
        result.problems.push(kind + " could not be read: " + p + " (" + item.error + ")");
        continue;
      }
      var got = (item.sha256 || "").toLowerCase();
      if (got !== entry.sha256) {
        result.problems.push(
          kind + " hash mismatch: " + p + "\n  manifest " + entry.sha256 + "\n  loaded   " + got,
        );
      } else if (!knownHashes.has(got)) {
        result.problems.push(kind + " hash not attested: " + p);
      } else {
        result.ok.push(kind + " " + p);
      }
    }
    result.counts.executables = executables;
    result.counts.styles = styles;

    // --- backward: every mandatory entrypoint must have been loaded --------
    var ep = manifest.entrypoints || {};
    var mandatory = [].concat(ep.rootMainFiles || [], ep.polyfillFiles || []);
    for (var k = 0; k < mandatory.length; k++) {
      if (!loadedPaths.has(mandatory[k])) {
        result.problems.push("mandatory entrypoint not loaded: " + mandatory[k]);
      }
    }
    if (mandatory.length > 0 && result.problems.length === 0) {
      result.ok.push("all " + mandatory.length + " mandatory entrypoints loaded");
    }

    // --- inline: bootstrap pinned, everything else a flight-data push ------
    var inlineSpec = manifest.inline || {};
    for (var m = 0; m < inline.length; m++) {
      var s = inline[m];
      var h = (s.sha256 || "").toLowerCase();
      var text = s.text || "";
      if (inlineSpec.bootstrapSha256 && h === inlineSpec.bootstrapSha256) continue;
      if (inlineSpec.dataPushPrefix && text.indexOf(inlineSpec.dataPushPrefix) === 0) continue;
      result.problems.push(
        "unexpected inline script (" +
          text.length +
          " bytes): " +
          text.slice(0, 60).replace(/\s+/g, " ") +
          "…",
      );
    }

    result.status = result.problems.length === 0 ? "green" : "red";
    return result;
  }

  return { evaluate: evaluate };
});
