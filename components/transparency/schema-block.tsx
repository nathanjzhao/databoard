/**
 * The schema, rendered verbatim. The string arrives from readSchemaSql(),
 * which is the same generated module lib/db.ts applies at startup; this
 * component adds nothing but line-level color (comment lines dimmed) and a
 * header with the byte-for-byte checksum. The text content is the file.
 */

import { CopyButton } from "@/components/copy-button";

export function SchemaBlock({
  schema,
  sha256,
}: {
  schema: string;
  sha256: string;
}) {
  const lines = schema.split("\n");

  return (
    <figure className="border border-rule bg-panel">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5">
        <span className="bt-token">db/schema.sql</span>
        <span className="bt-label">{lines.length} lines</span>
        <span
          className="bt-label hidden truncate sm:inline"
          title={`sha256 ${sha256}`}
        >
          sha256 {sha256.slice(0, 16)}&hellip;
        </span>
        <span className="ml-auto flex items-center gap-2">
          <a
            href="/api/transparency/schema"
            className="bt-btn px-2.5 py-1 text-[0.6875rem]"
          >
            Raw
          </a>
          <CopyButton
            value={schema}
            label="Copy"
            className="px-2.5 py-1 text-[0.6875rem]"
          />
        </span>
      </figcaption>
      <pre className="max-h-[72vh] overflow-auto p-4 font-mono text-[0.75rem] leading-[1.75]">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.trimStart().startsWith("--")
                ? "text-ink-faint"
                : "text-ink-dim"
            }
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </figure>
  );
}
