import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client carries a native binding for local file mode. Leave the
  // package to node's resolver instead of letting the bundler trace it.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // tests/hardening.spec.ts boots extra dev servers (non-demo OTP env) next
  // to the main one. Next's dev single-instance lock lives at distDir/lock,
  // so each spawned server needs its own distDir. Unset everywhere else, so
  // dev, build and deploys keep the default .next.
  distDir: process.env.NEXT_TEST_DIST_DIR || undefined,
};

export default nextConfig;
