import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client carries a native binding for local file mode. Leave the
  // package to node's resolver instead of letting the bundler trace it.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Pin the build id to the commit SHA. By default Next mints a random build
  // id, which makes `.next/static/<buildId>/` and every chunk name a fresh
  // string per build and puts one more non-source input between a commit and
  // its served bytes. Deriving it from the commit removes that one source of
  // nondeterminism, so two builds of the SAME commit at least agree on the
  // build id and the static path layout. This does NOT make the build
  // byte-for-byte reproducible: Next still bakes nondeterministic Server
  // Action ids and per-build secrets into the chunks, so the honest claim
  // stays "served bytes match the CI-attested manifest for commit C", not
  // "these bytes provably rebuild from public source". generateBuildId runs
  // only during `next build`; returning null falls back to Next's default.
  generateBuildId: async () => {
    const fromEnv =
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null;
    if (fromEnv) return fromEnv;
    try {
      const { execFileSync } = await import("node:child_process");
      return execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  },
  // tests/hardening.spec.ts boots extra dev servers (non-demo OTP env) next
  // to the main one. Next's dev single-instance lock lives at distDir/lock,
  // so each spawned server needs its own distDir. Unset everywhere else, so
  // dev, build and deploys keep the default .next.
  distDir: process.env.NEXT_TEST_DIST_DIR || undefined,
  // The served-JS manifest route reads lib/js-manifest.generated.json at
  // request time (scripts/gen-js-manifest.mjs writes it after `next build`;
  // a pre-build stub pass guarantees the path exists when this glob resolves
  // during the build). Pin it into the route's serverless bundle explicitly
  // instead of trusting static analysis of the readFileSync call.
  outputFileTracingIncludes: {
    "/api/transparency/js-manifest": ["lib/js-manifest.generated.json"],
  },
};

export default nextConfig;
