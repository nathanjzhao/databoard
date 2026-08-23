/**
 * The two-column honesty table: what the operator (and anyone who compels the
 * operator) can read out of the database, next to what is not in it. Static
 * content; if the schema grows a column, this table is the other file to
 * update, and /transparency's live column scan will nag until it is honest.
 */

const CAN_SEE: ReadonlyArray<readonly [string, string]> = [
  ["Usernames", "the one identity every account chose for itself"],
  ["Ask contents", "titles, descriptions, volumes, price bands, status"],
  [
    "Blind tokens",
    "contact indexes and buyer tokens, as opaque hex with no names attached",
  ],
  [
    "Message and note text",
    "stored in the clear; this is not end-to-end encrypted",
  ],
  ["Timestamps", "when rows were created, updated, read"],
  [
    "Deal amounts and splits",
    "exact dollars, in the clear; public surfaces round to $10k, the database does not",
  ],
  [
    "Evidence hashes",
    "64 hex characters and a label per commitment; fingerprints of documents, not documents",
  ],
];

const CANNOT_SEE: ReadonlyArray<readonly [string, string]> = [
  ["Phone numbers", "no column exists; only the keyed blind index"],
  ["Email addresses", "same: the address is keyed and dropped at signup"],
  ["Real names", "attested into the signup challenge, never written"],
  ["Org names", "reduced to a single org-or-individual bit"],
  ["Lab names", "keyed to a buyer token in the posting request, then dropped"],
  ["Which human owns a username", "nothing stored links the two"],
  [
    "Documents behind evidence hashes",
    "hashed in the participant's browser; the file itself never arrives",
  ],
];

function VisList({
  rows,
  tone,
}: {
  rows: ReadonlyArray<readonly [string, string]>;
  tone: "can" | "cannot";
}) {
  return (
    <ul className="divide-y divide-rule">
      {rows.map(([thing, note]) => (
        <li key={thing} className="px-4 py-3">
          <span
            className={[
              "text-[0.875rem]",
              tone === "can" ? "text-ink" : "text-ink line-through decoration-red/60 decoration-1",
            ].join(" ")}
          >
            {thing}
          </span>
          <span className="mt-0.5 block font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
            {note}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function VisibilityTable() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="border border-rule bg-panel">
        <div className="border-b border-rule px-4 py-2.5">
          <span className="bt-label text-amber">We can see</span>
        </div>
        <VisList rows={CAN_SEE} tone="can" />
      </div>
      <div className="relative border border-rule bg-panel">
        <div className="bt-hatch pointer-events-none absolute inset-0 opacity-30" />
        <div className="relative">
          <div className="border-b border-rule px-4 py-2.5">
            <span className="bt-label text-ink-dim">We cannot see</span>
          </div>
          <VisList rows={CANNOT_SEE} tone="cannot" />
        </div>
      </div>
    </div>
  );
}
