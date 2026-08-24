/**
 * The two-column honesty table: what the operator (and anyone who compels the
 * operator) can read out of the database, next to what is not in it. Static
 * content; if the schema grows a column, this table is the other file to
 * update, and /transparency's live column scan will nag until it is honest.
 */

const CAN_SEE: ReadonlyArray<readonly [string, string]> = [
  ["Handles", "the one identity per account, assigned at random so it points at nothing"],
  ["Ask contents", "titles, descriptions, volumes, price bands, status"],
  [
    "Blind tokens",
    "contact indexes and buyer tokens, as opaque hex with no names attached",
  ],
  [
    "Collab notes and legacy message text",
    "notes on collab requests are plaintext, and threads from before encryption stay readable and are labeled",
  ],
  [
    "Messaging metadata",
    "who is in which thread, when messages were sent, and thread subjects; encryption covers bodies, not structure",
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
  [
    "Which lab an ask names",
    "never received: blinded in your browser before send (RFC 9497 VOPRF), the server evaluates an opaque point",
  ],
  ["Which human owns a handle", "assigned, not chosen, and nothing stored links the two"],
  [
    "Documents behind evidence hashes",
    "hashed in the participant's browser; the file itself never arrives",
  ],
  [
    "Message text in encrypted threads",
    "sealed in the sender's browser; the server stores ciphertext and wrapped keys it cannot open",
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
