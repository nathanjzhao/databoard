/**
 * GET /api/transparency/js-manifest
 *
 * The SHA-256 integrity manifest of every executable and style asset this
 * deployment serves under /_next/static: one entry per file with path, hash,
 * and byte count, plus the commit it was built from, the mandatory app-shell
 * entrypoints, the stable inline Flight bootstrap, and the provenance block
 * (repo, workflow, and the `gh attestation verify` command for the Sigstore
 * attestation CI made over this manifest's digest). Written by
 * scripts/gen-js-manifest.mjs immediately after `next build`. Public by
 * design, same as /api/transparency/schema (lib/gate.ts serves the
 * /api/transparency/ prefix without a session).
 *
 * Why a runtime read instead of the schema.generated import pattern: the
 * manifest's content exists only after the build finishes, so a build-time
 * import would freeze whatever the file held before this build. The file is
 * pinned into this route's serverless bundle by outputFileTracingIncludes in
 * next.config.ts (a pre-build stub pass makes the path exist when the trace
 * glob resolves; the post-build run overwrites it with the real hashes), so
 * this handler serves the bytes of the build actually running.
 *
 * What this proves, stated honestly on /transparency/code: the outside
 * verifier (tools/code-verify-extension, or scripts/verify-served-js.sh)
 * hashes the bytes the browser actually ran and checks them against THIS
 * manifest, both directions. The manifest's own trust comes from the Sigstore
 * attestation over its digest (bound to the CI workflow at this commit) and
 * from its digest being logged as a `served_manifest` leaf in the append-only
 * transparency log. A page cannot verify itself when the origin is the
 * adversary, so the trust anchor is the installed extension / CLI, never this
 * response. The route serves the bytes as-is and adds no claim of its own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const unavailable = Response.json(
    {
      error:
        "manifest not generated for this build; run npm run build (scripts/gen-js-manifest.mjs runs after next build)",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
  let json: string;
  try {
    json = readFileSync(
      path.join(process.cwd(), "lib", "js-manifest.generated.json"),
      "utf8",
    );
    // The pre-build stub (written only so the build trace can see the path)
    // and anything else without a files array are not a manifest. Say so
    // instead of serving empty claims with a 200.
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { files?: unknown }).files)
    ) {
      return unavailable;
    }
  } catch {
    // No manifest on disk: a dev server, or a build that skipped the
    // postbuild step.
    return unavailable;
  }
  return new Response(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
