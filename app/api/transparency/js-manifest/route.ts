/**
 * GET /api/transparency/js-manifest
 *
 * The SHA-256 manifest of every static asset this deployment serves under
 * /_next/static: one entry per file with path, hash, and byte count, written
 * by scripts/gen-js-manifest.mjs immediately after `next build`. Public by
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
 * What this proves, stated honestly on /transparency: that the static JS you
 * receive matches the manifest the same server published. Cross-checking the
 * manifest against the CI artifact for the stamped commit is what makes it
 * third-party. scripts/verify-served-js.sh automates the first step.
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
