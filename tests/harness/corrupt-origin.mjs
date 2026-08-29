/*
 * tests/harness/corrupt-origin.mjs
 *
 * A node harness for the served-JS integrity counterfactual (verifiable.spec
 * JS-1). scripts/verify-served-js.sh fetches a deployment's manifest and then
 * fetches the static bundles it lists, checking each one's SHA-256 against the
 * manifest. To prove that check actually bites, we need an origin that serves a
 * VALID manifest but hands out ONE asset whose bytes do not match it, the way a
 * server that swapped a chunk for tampered code would.
 *
 * This spins up exactly that: an HTTP origin that
 *   - serves the given manifest bytes verbatim at /api/transparency/js-manifest
 *     (same digest, same file list as the real deployment), and
 *   - serves /_next/static/<rel> from the real build output on disk, EXCEPT for
 *     one target path whose last byte it flips, so its served hash diverges from
 *     the manifest while every other file still matches.
 *
 * Point scripts/verify-served-js.sh at its URL with `all` and it must exit
 * nonzero and name the corrupted path. Serving `corruptRel: null` yields a
 * faithful origin (every asset matches) so the same harness can also show the
 * PASS side against controlled bytes.
 *
 * Importable: `startCorruptOrigin({ manifestJson, staticDir, corruptRel })`
 * returns `{ url, close }`. Not a long-running service; the caller closes it.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function startCorruptOrigin({ manifestJson, staticDir, corruptRel }) {
  const staticRoot = path.resolve(staticDir);
  const MANIFEST_PATH = "/api/transparency/js-manifest";
  const STATIC_PREFIX = "/_next/static/";

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    if (pathname === MANIFEST_PATH) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(manifestJson);
      return;
    }

    if (pathname.startsWith(STATIC_PREFIX)) {
      const rel = decodeURIComponent(pathname.slice(STATIC_PREFIX.length));
      const abs = path.resolve(staticRoot, rel);
      // Never serve outside the build output, even if asked with `..`.
      if (abs !== staticRoot && !abs.startsWith(staticRoot + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let buf;
      try {
        buf = readFileSync(abs);
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      if (corruptRel && rel === corruptRel && buf.length > 0) {
        // One flipped byte: same length, different SHA-256. This is the single
        // tampered asset the verifier must catch.
        buf = Buffer.from(buf);
        buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
      }
      res.writeHead(200, { "Cache-Control": "no-store" });
      res.end(buf);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
