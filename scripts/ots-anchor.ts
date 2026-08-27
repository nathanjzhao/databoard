/**
 * scripts/ots-anchor.ts
 *
 * Anchor the transparency log's signed tree head into Bitcoin's timestamp with
 * OpenTimestamps. This is the REAL external anchor the log needs: the git
 * commit of a head (scripts/anchor-sth.ts) is a witness the operator still
 * controls and could force-push, but an OpenTimestamps proof commits the head's
 * hash into the Bitcoin blockchain through calendar servers the operator does
 * not run. Once a head is stamped, the operator cannot backdate or fork the
 * log's history past that point without it being externally detectable,
 * independent of our own git.
 *
 * NO NEW DEPENDENCY. It speaks the documented OpenTimestamps calendar HTTP API
 * directly (POST <calendar>/digest with the raw 32-byte digest; the calendar
 * returns a serialized timestamp), and writes a standard `.ots` DetachedTimestamp
 * file by wrapping that response in the OTS header, so the ordinary `ots`
 * client can `ots upgrade` and `ots verify` it once Bitcoin confirms.
 *
 * WHAT IT STAMPS. The bytes of docs/transparency-log/sth-<treeSize>.json, the
 * same file scripts/anchor-sth.ts writes, so the two anchors witness the exact
 * same head. Freshly-submitted proofs are PENDING (they point to the calendar's
 * commitment, not yet a Bitcoin block); `ots upgrade` completes them over the
 * next hours. That is standard OTS behaviour, and is documented in
 * docs/transparency-log/ots/README.md.
 *
 * MODES.
 *   node scripts/ots-anchor.ts --url https://getdataboard.vercel.app
 *     Fetch and VERIFY the live head, write sth-<n>.json if missing, stamp it.
 *   node scripts/ots-anchor.ts --local
 *     Same, against the database this environment points at.
 *   node scripts/ots-anchor.ts --stamp-file docs/transparency-log/sth-3.json
 *     Stamp an existing file's bytes directly (offline; no STH fetch). Useful to
 *     anchor a head already committed to the repo.
 */

import { writeFile, mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySth, type Sth } from "../lib/merkle.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "docs", "transparency-log");
const OTS_DIR = path.join(OUT_DIR, "ots");

/**
 * The OpenTimestamps DetachedTimestampFile header, byte-for-byte from
 * python-opentimestamps: 0x00 "OpenTimestamps" 0x00 0x00 "Proof" 0x00 + 8 magic
 * bytes. Followed by the major version varint (1), the file-hash op tag
 * (OpSHA256 = 0x08), the 32-byte file digest, then the timestamp the calendar
 * returned. That assembly is exactly what `ots stamp` produces for a file whose
 * SHA-256 equals the digest, so `ots` can read and upgrade the result.
 */
const OTS_HEADER_MAGIC = Buffer.concat([
  Buffer.from([0x00]),
  Buffer.from("OpenTimestamps", "ascii"),
  Buffer.from([0x00, 0x00]),
  Buffer.from("Proof", "ascii"),
  Buffer.from([0x00]),
  Buffer.from([0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
]);
const OTS_MAJOR_VERSION = Buffer.from([0x01]); // varint(1)
const OP_SHA256_TAG = Buffer.from([0x08]);

/** The free public calendars. First to answer is enough; the rest are backups. */
const CALENDARS = [
  { name: "alice", url: "https://alice.btc.calendar.opentimestamps.org" },
  { name: "bob", url: "https://bob.btc.calendar.opentimestamps.org" },
  { name: "finney", url: "https://finney.calendar.eternitywall.com" },
  { name: "pool-a", url: "https://a.pool.opentimestamps.org" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function fromUrl(base: string): Promise<{ sth: Sth; publicKey: string }> {
  const trimmed = base.replace(/\/+$/, "");
  const [sthRes, keyRes] = await Promise.all([
    fetch(`${trimmed}/api/translog/sth`),
    fetch(`${trimmed}/api/translog/pubkey`),
  ]);
  if (!sthRes.ok) throw new Error(`GET ${trimmed}/api/translog/sth -> ${sthRes.status}`);
  if (!keyRes.ok) throw new Error(`GET ${trimmed}/api/translog/pubkey -> ${keyRes.status}`);
  const sth = (await sthRes.json()) as Sth;
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  return { sth, publicKey };
}

async function fromDb(): Promise<{ sth: Sth; publicKey: string }> {
  const { getSignedHead, logPublicKeyHex } = await import("../lib/translog.ts");
  const { closeDb } = await import("../lib/db.ts");
  try {
    return { sth: await getSignedHead(), publicKey: logPublicKeyHex() };
  } finally {
    closeDb();
  }
}

/** POST the raw digest to one calendar; return the serialized timestamp bytes. */
async function submitToCalendar(
  calUrl: string,
  digest: Buffer,
  timeoutMs = 20_000,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${calUrl.replace(/\/+$/, "")}/digest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Accept: "application/vnd.opentimestamps.v1",
        "User-Agent": "databoard-ots-anchor/1.0",
      },
      // A plain Uint8Array view: the DOM BodyInit type does not accept a
      // node Buffer directly, though the runtime handles either.
      body: Uint8Array.from(digest),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("empty timestamp");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Assemble a standard single-calendar .ots from the digest and the response. */
function buildOts(digest: Buffer, calendarTimestamp: Buffer): Buffer {
  return Buffer.concat([
    OTS_HEADER_MAGIC,
    OTS_MAJOR_VERSION,
    OP_SHA256_TAG,
    digest,
    calendarTimestamp,
  ]);
}

async function main() {
  await mkdir(OTS_DIR, { recursive: true });

  // Resolve the file to stamp and a label for the output names.
  let fileToStamp: string;
  let label: string;

  const stampFile = arg("--stamp-file");
  if (stampFile) {
    fileToStamp = path.resolve(ROOT, stampFile);
    if (!existsSync(fileToStamp)) throw new Error(`No such file: ${fileToStamp}`);
    label = path.basename(fileToStamp).replace(/\.json$/, "");
  } else {
    const base = arg("--url") ?? process.env.ANCHOR_STH_URL;
    const local = has("--local") || (!base && !process.env.ANCHOR_STH_URL);
    const { sth, publicKey } = local
      ? await fromDb()
      : await fromUrl(base ?? "https://getdataboard.vercel.app");
    if (!verifySth(sth, publicKey)) {
      throw new Error("Refusing to anchor: the STH signature does not verify against the public key.");
    }
    // Write the head file if it is not already there, in the same format
    // anchor-sth.ts uses, so both anchors stamp identical bytes.
    const sthPath = path.join(OUT_DIR, `sth-${sth.treeSize}.json`);
    if (!existsSync(sthPath)) {
      await writeFile(sthPath, JSON.stringify(sth, null, 2) + "\n");
    }
    fileToStamp = sthPath;
    label = `sth-${sth.treeSize}`;
  }

  const fileBytes = await readFile(fileToStamp);
  const digest = createHash("sha256").update(fileBytes).digest();
  console.log(`ots-anchor: stamping ${path.relative(ROOT, fileToStamp)}`);
  console.log(`ots-anchor: sha256 ${digest.toString("hex")}`);

  const succeeded: { name: string; url: string; bytes: number; otsPath: string }[] = [];
  for (const cal of CALENDARS) {
    try {
      const ts = await submitToCalendar(cal.url, digest);
      const ots = buildOts(digest, ts);
      const otsPath = path.join(OTS_DIR, `${label}.${cal.name}.ots`);
      await writeFile(otsPath, ots);
      succeeded.push({ name: cal.name, url: cal.url, bytes: ots.length, otsPath });
      console.log(
        `ots-anchor: ${cal.name} responded (${ts.length} bytes) -> ${path.relative(ROOT, otsPath)}`,
      );
    } catch (err) {
      console.warn(`ots-anchor: ${cal.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (succeeded.length === 0) {
    console.error(
      "ots-anchor: no calendar responded. The wire step is a single POST of the 32-byte\n" +
        `  digest above to <calendar>/digest, e.g.:\n` +
        `    printf '%s' ${digest.toString("hex")} | xxd -r -p | \\\n` +
        `      curl -s --data-binary @- -H 'Content-Type: application/octet-stream' \\\n` +
        `      ${CALENDARS[0].url}/digest > ${label}.ots.timestamp\n` +
        "  Then wrap it with the OTS header (see docs/transparency-log/ots/README.md) or\n" +
        "  run `ots stamp` on the sth file directly. Nothing was written.",
    );
    process.exit(2);
  }

  // A small companion record, appended per run, so the sequence of stamps is
  // itself a log next to anchors.ndjson.
  const meta = {
    file: path.relative(ROOT, fileToStamp),
    label,
    sha256: digest.toString("hex"),
    calendars: succeeded.map((s) => ({ name: s.name, url: s.url, otsBytes: s.bytes })),
    pending: true,
    stampedAt: Date.now(),
  };
  await writeFile(
    path.join(OTS_DIR, `${label}.ots.json`),
    JSON.stringify(meta, null, 2) + "\n",
  );
  await appendFile(path.join(OTS_DIR, "stamps.ndjson"), JSON.stringify(meta) + "\n");

  console.log(
    `ots-anchor: wrote ${succeeded.length} pending proof(s) under docs/transparency-log/ots/.`,
  );
  console.log("ots-anchor: these are PENDING Bitcoin confirmation; complete them later with");
  console.log(`ots-anchor:   ots upgrade docs/transparency-log/ots/${label}.${succeeded[0].name}.ots`);
  console.log(`ots-anchor:   ots verify --digest ${digest.toString("hex")} docs/transparency-log/ots/${label}.${succeeded[0].name}.ots`);
  console.log("ots-anchor: commit docs/transparency-log/ots/ to publish the anchor.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
