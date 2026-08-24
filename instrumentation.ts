/**
 * instrumentation.ts
 *
 * Next server instrumentation (Next 15+ convention). onRequestError fires
 * whenever the server captures an error in a render, route handler, server
 * action or proxy, and hands it to lib/ops.ts, which owns every privacy
 * rule (pathname only, no bodies/headers/cookies, scrubbed and capped text,
 * per-digest sampling, fail-silent writes).
 *
 * Signature verified against this build's types
 * (node_modules/next/dist/server/instrumentation/types.d.ts):
 *   (error: unknown,
 *    request: Readonly<{ path; method; headers }>,
 *    context: Readonly<{ routerKind; routePath; routeType; renderSource?;
 *                        revalidateReason }>) => void | Promise<void>
 *
 * request.headers is deliberately never read: the capture path takes only
 * the path (query-stripped downstream) and the error itself.
 */

import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  // The database client is Node-only; skip the edge runtime.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  try {
    const { captureError } = await import("./lib/ops.ts");

    const isError = err instanceof Error;
    const digest =
      typeof err === "object" && err !== null && "digest" in err
        ? String((err as { digest?: unknown }).digest ?? "")
        : undefined;

    await captureError({
      route: request.path,
      kind: context.renderSource
        ? `${context.routeType}:${context.renderSource}`
        : context.routeType,
      message: isError ? `${err.name}: ${err.message}` : String(err),
      stack: isError ? (err.stack ?? "") : "",
      digest,
    });
  } catch {
    // Instrumentation must never take a request down with it.
  }
};
