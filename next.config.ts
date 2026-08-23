import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client carries a native binding for local file mode. Leave the
  // package to node's resolver instead of letting the bundler trace it.
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
