-- ============================================================================
-- DATABOARD / db/schema.sql
--
-- This is the entire database. Every table, every column. A prebuild step
-- copies this file into lib/schema.generated.ts; lib/db.ts applies it
-- verbatim and idempotently on the first query, and /transparency renders the
-- same bytes, so the schema you can read is the schema that runs.
--
-- THE CLAIM: no column in this file holds a phone number, an email address,
-- a real name, an organization name, or the name of a buyer. Not encrypted,
-- not hashed-with-a-known-salt, not "temporarily". The columns simply do not
-- exist. If you want to audit that, there is nothing to read but this file.
--
-- Three things are one-way transformed (see lib/crypto.ts, lib/voprf.ts):
--   contact_blind_index  HMAC(SERVER_PEPPER, normalized phone or email)
--   buyer_token          "v2:" + RFC 9497 VOPRF output, minted BLIND in the
--                        poster's browser: the server evaluates a blinded
--                        point and never receives the name in any form.
--                        Rows from before the blind protocol hold the old
--                        HMAC(SERVER_PEPPER, normalized name) tokens.
--   password_hash        scrypt(password)
--
-- Real names and affiliations are ATTESTED at signup, not stored: they are
-- bound into a stateless HMAC challenge (lib/verify.ts) that round-trips
-- through the client, and the only residue is account_type, a single
-- org-or-individual bit.
--
-- Honest caveat, stated here and on /transparency: HMAC is one-way but it is
-- not amnesia. An operator holding the pepper can take a specific phone number
-- and test whether it is in the users table. They cannot go the other way, and
-- they cannot enumerate. That is the actual privacy boundary. We are not going
-- to pretend it is stronger than it is.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users
--
-- An account is a username, a password hash, one bit of affiliation, and a
-- blind index.
--
-- No PII here by construction:
--   * There is no email column, no phone column, no name column, no org
--     column. Verification happens statelessly (lib/verify.ts): contact, real
--     name and affiliation are HMAC'd into a challenge that travels through
--     the client and back, and none of them is ever written down.
--   * contact_blind_index is HMAC(SERVER_PEPPER, normalized_contact). It
--     exists for exactly one reason: the UNIQUE constraint, which stops one
--     phone number from farming a hundred accounts. It is never displayed,
--     never returned by any API, and never joined against anything.
--   * account_type is the entire residue of "org name or independent
--     individual": one of two strings, carrying nothing about which org.
--   * password_hash is scrypt. There is no password reset because there is no
--     contact to reset against. Lose the password, lose the account. The
--     signup page says so before you commit.
--   * username is chosen by the user and is the only identity the board sees.
--   * Encryption public keys live in user_e2ee_keys below, not in a column
--     here, because this schema is applied with CREATE ... IF NOT EXISTS
--     only: a new column on an existing table would silently not exist on a
--     database created before it. New tables are the honest additive path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT    PRIMARY KEY,
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  account_type        TEXT    NOT NULL CHECK (account_type IN ('org', 'individual')),
  contact_blind_index TEXT    NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- user_e2ee_keys
--
-- One X25519 PUBLIC key per account, for end-to-end encrypted messaging.
-- PUBLIC key material only, never a secret: the browser derives an X25519
-- keypair from the user's password with scrypt (lib/e2ee.ts), uploads the
-- public half at signup, and recomputes the private half at login into
-- memory that never leaves the device. The server cannot reconstruct the
-- private key from this row: that would require inverting scrypt over the
-- password, which is the same thing password_hash already makes hard.
--
-- The row is write-once: the first key registered for an account stays. A
-- swapped public key would let whoever swapped it read future thread keys,
-- so the API refuses overwrites, and a mismatch between this key and the one
-- a user's password derives is loud in the client, not silent.
--
-- No row = the account predates end-to-end encryption and has not signed in
-- since. Threads with such a participant stay plaintext and say so in the UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_e2ee_keys (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pubkey     TEXT    NOT NULL,   -- base64url X25519 public key, 32 bytes
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- sessions
--
-- A session is a random 32-byte token. The browser holds the token in an
-- httpOnly cookie; the server stores only sha256(token), so a dump of this
-- table does not let anyone log in as anybody.
--
-- No PII here: no IP address, no user agent, no device fingerprint, no
-- geolocation. We do not keep an access log keyed to accounts. The only
-- timestamps are the ones needed to expire the row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- rate_limits
--
-- Request counters behind the auth and VOPRF endpoints (lib/ratelimit.ts).
-- Fixed windows; each check reads the current window plus the previous one
-- weighted by how much of it still overlaps a sliding window, so a burst
-- cannot hide on a window boundary.
--
-- No PII here, and no raw limiter keys either: bucket is
-- HMAC(SERVER_PEPPER, "ratelimit" | scope | key), where key is an IP
-- address, a normalized contact, a handle, or a user id depending on the
-- scope. The HMAC is the same construction as contact_blind_index above,
-- which means this table never stores an IP or a contact in any form, and a
-- dump of it is counts against opaque hex. Rows expire with their window and
-- are swept opportunistically during later checks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- asks
--
-- The board. One row per RFP-style request for data.
--
-- No PII here:
--   * buyer_token ("v2:" prefix) is an RFC 9497 VOPRF output the poster's
--     BROWSER computed: the name was blinded client-side, evaluated by the
--     server without being seen, proof-checked, and unblinded into this
--     token. The name never crosses the wire in any form. Legacy rows
--     (no prefix) predate that and were HMAC-keyed server-side from a name
--     that was received once and dropped. The UI shows "Buyer #" plus four
--     hex characters, which is enough to see that two asks point at the
--     same buyer and not enough to say who.
--   * buyer_is_other is 1 when the poster typed a name that was not in the
--     known-buyer dropdown. It is a single bit and it exists so the board can
--     be honest that a token may be off-list. It leaks nothing about the name.
--   * title / description / modality_tags are free text written by the poster.
--     Those are the one place a determined user could out themselves, so the
--     compose form says so. We do not scrub it for them; that would require
--     reading it, and it is their post.
--   * There is no contact field. Contact happens in threads, in-band.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asks (
  id                TEXT    PRIMARY KEY,
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL,
  category          TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  modality_tags     TEXT    NOT NULL DEFAULT '',   -- comma separated slugs
  volume            TEXT    NOT NULL DEFAULT '',   -- free text, e.g. "50k trajectories"
  price_band        TEXT    NOT NULL DEFAULT '',   -- coarse band, never an exact figure
  supply_filled_pct INTEGER NOT NULL DEFAULT 0
                      CHECK (supply_filled_pct >= 0 AND supply_filled_pct <= 100),
  buyer_token       TEXT    NOT NULL,
  buyer_is_other    INTEGER NOT NULL DEFAULT 0 CHECK (buyer_is_other IN (0, 1)),
  status            TEXT    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'partial', 'closed')),
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asks_created  ON asks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asks_status   ON asks(status);
CREATE INDEX IF NOT EXISTS idx_asks_category ON asks(category);
CREATE INDEX IF NOT EXISTS idx_asks_buyer    ON asks(buyer_token);
CREATE INDEX IF NOT EXISTS idx_asks_user     ON asks(user_id);

-- ---------------------------------------------------------------------------
-- ask_mandates
--
-- An optional commitment pinning an ask to one mandate document: the RFP,
-- MSA or buyer email thread the poster says the ask answers to. The document
-- is hashed with SHA-256 in the poster's OWN BROWSER; only the 64-hex
-- fingerprint and a short label arrive here. Same construction as
-- deal_participants.evidence_hash: there is no upload path, so this table
-- cannot contain the document.
--
-- One mandate per ask, WRITE-ONCE: the primary key holds it to one row, and
-- the API refuses a second commit rather than replacing the first, because a
-- swappable hash pins nothing. committed_at is displayed next to the ask's
-- created_at everywhere the mandate shows, so a commitment added late is
-- visibly late rather than quietly backdated.
--
-- What a row proves: consistency. The poster fixed one document before (or
-- visibly after) anyone engaged, and a counterparty later shown a document
-- that does not hash to doc_hash has receipts. What it does not prove:
-- authenticity or authority. The poster can hash any file they like, and the
-- UI never says "verified"; the mark is "mandate committed".
--
-- No PII here: doc_hash is opaque hex, label is a short caption the poster
-- wrote (same free-text caveat as everything else they type).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_mandates (
  ask_id       TEXT    PRIMARY KEY REFERENCES asks(id) ON DELETE CASCADE,
  doc_hash     TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  committed_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- ask_activity
--
-- One row per ask: when the poster last affirmed the ask is still live, and
-- the short update note they typed when they did. Posting seeds the row;
-- supply updates and the "Still ongoing" button refresh it; a linked deal
-- reaching co-attested counts as an affirmation too, written here by
-- lib/deals.ts the moment the last participant settles. An open or partial
-- ask whose affirmation is more than 7 days old is closed by the autoclose pass
-- (/api/cron/autoclose) and the closure recorded in ask_closures below.
--
-- No PII here: a foreign key, a timestamp, and a free-text note the poster
-- wrote for display on their own ask page. Same free-text caveat as every
-- other note column: it is theirs to keep clean.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_activity (
  ask_id      TEXT    PRIMARY KEY REFERENCES asks(id) ON DELETE CASCADE,
  affirmed_at INTEGER NOT NULL,
  note        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ask_activity_affirmed ON ask_activity(affirmed_at);

-- ---------------------------------------------------------------------------
-- ask_closures
--
-- Why a closed ask closed. 'owner' means the poster closed it (or filled it
-- to 100); 'auto_stale' means the autoclose pass closed it after 7 days
-- without an affirmation, and the ask page says so in those words. One row
-- per ask, first writer wins: a closure is a historical fact, not a status
-- to overwrite. Asks closed before this table existed have no row and are
-- simply "closed", which is the honest amount of history we have for them.
--
-- No PII here: a foreign key, a two-value reason, a timestamp.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_closures (
  ask_id    TEXT    PRIMARY KEY REFERENCES asks(id) ON DELETE CASCADE,
  reason    TEXT    NOT NULL CHECK (reason IN ('auto_stale', 'owner')),
  closed_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- ask_terms
--
-- The one term the board makes posters state up front: whether supply
-- committed to this ask is exclusive (sold here, not resellable elsewhere)
-- or non-exclusive (suppliers may reuse it). One row per ask, written with
-- the post. Asks from before this table have no row and every surface shows
-- "terms unspecified" rather than guessing.
--
-- No PII here: a foreign key and one of two strings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_terms (
  ask_id      TEXT PRIMARY KEY REFERENCES asks(id) ON DELETE CASCADE,
  exclusivity TEXT NOT NULL CHECK (exclusivity IN ('exclusive', 'nonexclusive'))
);

-- ---------------------------------------------------------------------------
-- collab_requests
--
-- Someone reading an ask says "I have some of that". One row per person per
-- ask, enforced by the UNIQUE constraint so nobody can spam a poster.
--
-- No PII here: the requester is a user_id, which resolves to a username and
-- nothing else. The note is free text the requester chose to write. There is
-- no attachment table, no file store, no "share your email to continue".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collab_requests (
  id           TEXT    PRIMARY KEY,
  ask_id       TEXT    NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
  requester_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note         TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at   INTEGER NOT NULL,
  UNIQUE (ask_id, requester_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_ask       ON collab_requests(ask_id);
CREATE INDEX IF NOT EXISTS idx_collab_requester ON collab_requests(requester_id);

-- ---------------------------------------------------------------------------
-- threads
--
-- A private conversation, usually attached to the ask that started it.
--
-- No PII here: a subject line and two timestamps. Participants live in their
-- own table so that a thread row on its own tells you nothing about who is in
-- it. ask_id is nullable so a thread survives its ask being deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT    PRIMARY KEY,
  ask_id          TEXT    REFERENCES asks(id) ON DELETE SET NULL,
  subject         TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threads_ask  ON threads(ask_id);
CREATE INDEX IF NOT EXISTS idx_threads_last ON threads(last_message_at DESC);

-- ---------------------------------------------------------------------------
-- thread_participants
--
-- Membership, and the read cursor that drives the unread badge.
--
-- No PII here: two foreign keys and two timestamps. last_read_at is per
-- participant and is the only read-receipt-shaped thing in the schema. There
-- is no typing indicator, no presence, no online-at column, because each of
-- those is a behavioral trace we would then have to defend keeping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id    TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_user ON thread_participants(user_id);

-- ---------------------------------------------------------------------------
-- thread_keys
--
-- End-to-end encryption for a thread: one wrapped copy of the thread's
-- random 32-byte message key per participant. The key is generated in the
-- FIRST participant's browser to open the thread, wrapped for every seat
-- with X25519 ECDH against each participant's registered public key
-- (user_e2ee_keys) plus a fresh ephemeral keypair, and uploaded here. The
-- server relays wrapped bytes it cannot open: unwrapping takes a private
-- key that only ever exists in a participant's browser.
--
-- Rows for a thread are written once, all seats in one transaction, and
-- never updated: replacing a wrap is how an operator would mount a key
-- substitution, so the API refuses it. A thread with no rows here is a
-- plaintext thread (it predates encryption, or a participant has no
-- registered key) and the UI labels it as such.
--
-- Honest limits, stated where they can be audited: the operator still sees
-- WHO talks to whom and when (threads, participants, timestamps, subjects
-- are not encrypted), and a tampered client script could exfiltrate keys.
-- The ciphertext guarantee holds against the database, not against serving
-- malicious JavaScript; /transparency spells this out.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thread_keys (
  thread_id   TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id     TEXT    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  wrapped_key TEXT    NOT NULL,   -- base64url: 12-byte nonce || AES-GCM(thread key)
  eph_pubkey  TEXT    NOT NULL,   -- base64url X25519 ephemeral public key for this wrap
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_keys_user ON thread_keys(user_id);

-- ---------------------------------------------------------------------------
-- messages
--
-- The message body. In a thread with thread_keys rows the body is an
-- end-to-end encrypted envelope (version tag, nonce, AES-256-GCM ciphertext,
-- base64url) sealed in the sender's browser with the thread key; the server
-- enforces that such threads only accept envelope-shaped bodies and stores
-- ciphertext it cannot read. In a thread without thread_keys rows the body
-- is plaintext, in the clear, readable by the operator, and the UI says so
-- on every such thread. Messages written before encryption existed stay as
-- plaintext rows, labeled honestly, rather than being rewritten.
--
-- Metadata is not encrypted either way: sender_id, thread_id and created_at
-- are visible to the operator. What the operator cannot do is tie any of it
-- back to a phone number or an inbox, because neither was ever collected.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT    PRIMARY KEY,
  thread_id  TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id  TEXT    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- ---------------------------------------------------------------------------
-- deals
--
-- The deals ledger. One row per reported deal: a reporter says "this buyer
-- paid this much, and these people were part of it". Deals are multi-party
-- and the split is uneven by design; the split itself lives in
-- deal_participants, one row per person, the reporter included.
--
-- No PII here:
--   * buyer_token is the same blinded token the asks table uses: minted in
--     the reporter's browser via the VOPRF, so the name never crossed the
--     wire (legacy unprefixed rows were HMAC-keyed server-side).
--     buyer_is_other is the same single honesty bit as on asks.
--   * total_usd is an EXACT dollar figure stored in the clear. Read that
--     twice: deal amounts are not blinded, not banded, and the operator can
--     see them. The transparency page says so. Public surfaces (the
--     leaderboard) round to the nearest $10k; exact figures are shown only
--     to the deal's own participants.
--   * ask_id and thread_id are internal keys, nullable so a deal outlives a
--     deleted ask or its deal-room thread.
--   * note is free text the reporter chose to write. Same rule as asks: the
--     one place a poster can out themselves, and nobody scrubs it for them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id             TEXT    PRIMARY KEY,
  reporter_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ask_id         TEXT    REFERENCES asks(id)    ON DELETE SET NULL,
  thread_id      TEXT    REFERENCES threads(id) ON DELETE SET NULL,
  buyer_token    TEXT    NOT NULL,
  buyer_is_other INTEGER NOT NULL DEFAULT 0 CHECK (buyer_is_other IN (0, 1)),
  total_usd      INTEGER NOT NULL CHECK (total_usd > 0),
  note           TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deals_reporter ON deals(reporter_id);
CREATE INDEX IF NOT EXISTS idx_deals_buyer    ON deals(buyer_token);
CREATE INDEX IF NOT EXISTS idx_deals_created  ON deals(created_at DESC);

-- ---------------------------------------------------------------------------
-- deal_participants
--
-- One row per person on a deal. The reporter gets a row too (role
-- 'reporter'), confirmed at creation, because their own share follows the
-- same accounting as everyone else's. Every other named participant starts
-- 'pending' and confirms or declines independently, on their own account. A
-- declined row never counts anywhere, for anyone; other participants'
-- confirmations stand on their own.
--
-- No PII here:
--   * user_id resolves to a username and nothing else.
--   * share_usd is that person's exact cut, in the clear, same caveat as
--     deals.total_usd: visible to the operator, rounded on public surfaces,
--     exact only to the deal's own participants.
--   * evidence_hash is a SHA-256 the participant computed in their own
--     browser over a document the server never receives. It is a
--     commitment, not a document: 64 hex characters that prove nothing on
--     their own, and can be checked later by hashing the original in front
--     of whoever is asking. evidence_label is a short caption the
--     participant wrote for it. Neither column can contain the document
--     because the document never arrives.
--   * confirmed_at is the one timestamp; it drives "k of n confirmed" and
--     the leaderboard's 30-day pair cap, nothing else.
--
-- The trigger below is the split arithmetic rule, enforced where an auditor
-- can read it: participant shares can never sum past the deal's total. An
-- unallocated remainder is legal (costs, parties not on the board).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_participants (
  deal_id        TEXT    NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT    NOT NULL CHECK (role IN ('reporter', 'participant')),
  share_usd      INTEGER NOT NULL CHECK (share_usd >= 0),
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'declined')),
  confirmed_at   INTEGER,
  evidence_hash  TEXT,
  evidence_label TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (deal_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_participants_user ON deal_participants(user_id);

CREATE TRIGGER IF NOT EXISTS trg_deal_shares_within_total
BEFORE INSERT ON deal_participants
BEGIN
  SELECT RAISE(ABORT, 'deal shares exceed the deal total')
   WHERE (SELECT IFNULL(SUM(share_usd), 0)
            FROM deal_participants
           WHERE deal_id = NEW.deal_id) + NEW.share_usd
       > (SELECT total_usd FROM deals WHERE id = NEW.deal_id);
END;

-- ---------------------------------------------------------------------------
-- deal_close_dates
--
-- An optional, reporter-stated close date for a deal, recorded once when the
-- deal is filed. It exists for exactly one mechanism: the timely-recording
-- fee credit (lib/referrals.ts). A confirmed share on a deal whose stated
-- close date is within a short window of when the deal was actually recorded
-- (and whose earner committed evidence on their own row) owes a documented,
-- capped percentage LESS referral up its chain. The carrot makes prompt,
-- evidenced recording cheaper than late or none.
--
-- It is a NEW TABLE, not a column on deals, because this schema is applied
-- CREATE ... IF NOT EXISTS only: a column added to a table that predates it
-- would silently not exist on older databases. Deals filed without a stated
-- close date simply have no row here and earn no credit, so the table is
-- purely additive and every pre-existing accrual is unchanged.
--
-- No PII here: a foreign key and two timestamps. stated_close_at is a date
-- the reporter typed (day granularity, in ms); recorded_at mirrors the deal's
-- created_at so the credit rule reads one self-contained row. Neither is a
-- dollar figure, a name, or a buyer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_close_dates (
  deal_id         TEXT    PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  stated_close_at INTEGER NOT NULL,
  recorded_at     INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- user_signing_keys
--
-- One Ed25519 PUBLIC signing key per account, the sibling of user_e2ee_keys:
-- where that key ENCRYPTS, this one SIGNS. The browser derives it from the
-- password (lib/e2ee.ts deriveSigningKeys): the one e2ee scrypt seed, split
-- with HKDF-SHA256 under a DISTINCT domain ("databoard-e2ee-v1/sign") so the
-- signing public key is unrelated to the X25519 encryption public key and
-- neither shares anything with the server's random password salt. PUBLIC key
-- material only, base64url; the private half is recomputed from the password
-- in the browser and never travels. Registered at login/signup where e2ee is
-- (app/api/signing/pubkey), and served back as a public key directory so a
-- receipt verifier with no account can confirm a signing key belongs to a
-- handle.
--
-- What it is FOR: attestations the PARTIES sign with their own keys, not the
-- operator's. A co-attested deal's receipt now carries an Ed25519 signature
-- from each confirmed participant over the canonical receipt bytes
-- (deal_receipt_signatures, lib/receipt-attest.ts), and every step of a
-- commit-encrypt-pay-reveal exchange is signed with this key (lib/exchange.ts).
-- A valid receipt or chain therefore proves the NAMED PARTIES attested, not
-- merely that the operator's MAC is intact.
--
-- Write-once with the same honesty as user_e2ee_keys: the first key an account
-- registers stands (a swap would let a hijacked session forge that account's
-- attestations, so the API refuses overwrites), the binding is
-- trust-on-first-use against an operator-served directory rather than a
-- key-transparency proof, and a mismatch between this key and the one a
-- password derives is loud in the client. No row = the account predates
-- signing keys and has not signed in since; its receipts are platform-MAC only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_signing_keys (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pubkey     TEXT    NOT NULL,   -- base64url Ed25519 public key, 32 bytes
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- deal_receipt_signatures
--
-- Party signatures on a co-attested deal's portable receipt. Each confirmed
-- participant may sign the canonical receipt bytes (tier, participant signing
-- pubkeys, blinded buyer, bucketed amount, attested_at, deal id, translog seq)
-- with their own Ed25519 key (user_signing_keys), and that signature is stored
-- here and folded into the receipt token (lib/receipts.ts, lib/party-sigs.ts).
-- The result: a valid co-attested receipt proves the parties THEMSELVES
-- attested, so the operator cannot forge one without their keys.
--
-- The row is keyed by (deal_id, user_id, seq): seq is the receipt_minted
-- transparency-log sequence the signature commits to. A receipt's bytes change
-- when the deal changes tier (a new leaf, a new seq), so a signature is scoped
-- to the exact receipt state it signed; a later state simply has no signature
-- yet and the UI asks the party to re-sign. pubkey is echoed for convenience
-- and MUST equal the signer's write-once user_signing_keys row (checked before
-- the row is written). No PII: two ids, a seq, and public key + signature,
-- both base64url.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_receipt_signatures (
  deal_id    TEXT    NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,   -- receipt_minted translog seq the sig commits to
  pubkey     TEXT    NOT NULL,   -- base64url Ed25519 public key that signed
  sig        TEXT    NOT NULL,   -- base64url Ed25519 signature over the canonical receipt bytes
  created_at INTEGER NOT NULL,
  PRIMARY KEY (deal_id, user_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_deal_receipt_sigs ON deal_receipt_signatures(deal_id, seq);

-- ---------------------------------------------------------------------------
-- ops_errors
--
-- Server errors, captured by the Next instrumentation hook (instrumentation.ts
-- -> lib/ops.ts) so the operator can see that something broke without running
-- an access log. One row per error, sampled: a digest seen in the last minute
-- is not written again.
--
-- No PII here, enforced at the write site (lib/ops.ts), auditable there:
--   * route is the request PATHNAME only. The query string is stripped before
--     the write, and request bodies, headers and cookies are never read by
--     the capture path at all, so a search term or a token in a URL cannot
--     end up in this table.
--   * kind is the router context Next reports (render / route / action /
--     proxy), a closed vocabulary carrying nothing user-written.
--   * message and stack are the error text, length-capped, with email-shaped
--     and long-digit substrings redacted before the write as a second fence:
--     even an exception that quotes user input does not land here verbatim.
--   * digest is Next's error digest when present, otherwise a hash of
--     kind + route + message. It exists for the sampling above and for
--     grouping, and identifies an ERROR, never a person. There is no user_id
--     column, no session column, no IP column: a row says what broke, not
--     who hit it.
--
-- Rows are pruned opportunistically after 30 days. Reading this table is
-- operator-only (/api/admin/errors).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_errors (
  id      TEXT    PRIMARY KEY,
  at      INTEGER NOT NULL,
  route   TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  message TEXT    NOT NULL,
  stack   TEXT    NOT NULL DEFAULT '',
  digest  TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ops_errors_at     ON ops_errors(at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_errors_digest ON ops_errors(digest, at);

-- ---------------------------------------------------------------------------
-- operators
--
-- Who can moderate. One row per account with the operator flag; the flag is
-- granted from the command line (scripts/grant-operator.ts), never from the
-- web, so the set of operators can only grow by someone who already holds
-- database credentials.
--
-- No PII here: an operator is a user_id, which resolves to a handle and
-- nothing else, exactly like every other actor in this schema. Moderation
-- does not get a name column, an email column, or a notes column, because
-- moderators do not get to know more about a person than the board does.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- hidden_asks
--
-- Moderation state for an ask: present means hidden. Hiding removes an ask
-- from the board, from matching and from other members' ask pages; it does
-- not delete the row, and the poster keeps seeing their own ask with a
-- banner naming the reason, because being moderated silently is worse than
-- being moderated.
--
-- No PII here:
--   * hidden_by is the operator's user_id: a handle, nothing more.
--   * reason is free text WRITTEN BY THE OPERATOR, shown verbatim to the
--     poster and on /admin. The hide form tells operators not to quote
--     contact details, names or anything else the schema refuses to store;
--     a reason is a category of problem ("spam", "solicits off-board
--     contact"), not a transcript. We cannot make SQL enforce that, so the
--     rule is stated where the text is typed and here where it lands.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hidden_asks (
  ask_id    TEXT    PRIMARY KEY REFERENCES asks(id) ON DELETE CASCADE,
  hidden_by TEXT    NOT NULL,
  reason    TEXT    NOT NULL,
  hidden_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- invites
--
-- The board is invite-only: signup consumes exactly one unused code, minted
-- server-side ("inv_" + 24 hex) by an existing member on /invites. A member
-- may hold at most 5 unused codes at a time (operators are uncapped);
-- consumption is a single guarded UPDATE, so a code raced by two signups is
-- spent exactly once and the loser is told so.
--
-- No PII here: a random code, two user ids that resolve to handles and
-- nothing else, and timestamps. A code says WHO vouched, never who anyone
-- is. Who-invited-whom is shown only to the two accounts on the edge and to
-- operators; it is stored, it is not public, and /transparency says so.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT    PRIMARY KEY,
  inviter_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  used_by    TEXT    REFERENCES users(id),
  used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invites_inviter ON invites(inviter_id);
CREATE INDEX IF NOT EXISTS idx_invites_used_by ON invites(used_by);

-- ---------------------------------------------------------------------------
-- invite_edges
--
-- The permanent genealogy: one row per invited account, written in the same
-- transaction that consumes the invite. It exists separately from invites
-- because that table cascades away with a deleted inviter, and the referral
-- ledger (lib/referrals.ts) needs the chain to outlive any single account's
-- housekeeping. Accounts from before invites existed simply have no row.
--
-- No PII here: same shape as invites. Visible only to the two accounts on
-- the edge and to operators, never on a public surface.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_edges (
  user_id     TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_id  TEXT    NOT NULL REFERENCES users(id),
  invite_code TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_edges_inviter ON invite_edges(inviter_id);

-- ---------------------------------------------------------------------------
-- referral_settlements
--
-- Records of referral fees settled OFF the platform. The accruals themselves
-- are never stored: lib/referrals.ts derives them at read time from
-- invite_edges x deal_participants (2.5% per step up the chain, capped at
-- depth 6). This table holds only what members chose to write down about
-- paying them: the payee (the ancestor, the creditor) records an amount
-- received, and the payer confirms it, the same two-sided ethos as deals.
-- Recorded, never custodied; no money touches the platform.
--
-- amount_cents is integer cents (the ledger's arithmetic is exact; only
-- DISPLAY rounds to whole dollars). No PII: user ids, an amount, a short
-- note the payee wrote (same free-text caveat as every other note column).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_settlements (
  id                 TEXT    PRIMARY KEY,
  payer_id           TEXT    NOT NULL REFERENCES users(id),
  payee_id           TEXT    NOT NULL REFERENCES users(id),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  note               TEXT    NOT NULL DEFAULT '',
  settled_at         INTEGER NOT NULL,
  confirmed_by_payer INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_by_payer IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_referral_settlements_payer ON referral_settlements(payer_id);
CREATE INDEX IF NOT EXISTS idx_referral_settlements_payee ON referral_settlements(payee_id);

-- ---------------------------------------------------------------------------
-- referral_disputes
--
-- The escape valve on the referral ledger. Either account on a payer/payee
-- pair can mark the pair disputed with one click; a disputed pair stops
-- counting toward "behind on referral obligations" (the posting gate) and is
-- flagged to operators. A dispute is loud and mutual by construction: both
-- parties see it on /invites. It is not forgiveness, it is a request for a
-- human to look.
--
-- No PII here: three user ids and a timestamp.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_disputes (
  payer_id  TEXT    NOT NULL REFERENCES users(id),
  payee_id  TEXT    NOT NULL REFERENCES users(id),
  raised_by TEXT    NOT NULL REFERENCES users(id),
  raised_at INTEGER NOT NULL,
  PRIMARY KEY (payer_id, payee_id)
);

-- ---------------------------------------------------------------------------
-- referral_dispute_status
--
-- The operator's resolution of a dispute, kept in its own table rather than
-- as columns on referral_disputes: this schema is applied CREATE ... IF NOT
-- EXISTS only, so a new column on a table that predates it would silently not
-- exist. A dispute with NO row here is 'open'. Resolution writes exactly one
-- row, first writer wins (PRIMARY KEY), so a second operator cannot overwrite
-- the first's ruling.
--
-- dispute_id is the parent row's identity spelled as one string,
-- payer_id || '.' || payee_id. User ids are prefixed base64url and contain no
-- dot, so the first dot splits it back cleanly; it is also what the resolve
-- route carries in its path.
--
-- Why this exists (the enforcement it restores): a raised dispute lifts the
-- posting gate, but only for a bounded window (lib/referrals.ts) or until an
-- operator resolves it here. 'upheld' keeps the gate lifted; 'rejected', like
-- the window lapsing, lets the debt revert to gating. Without a resolution
-- path a single pre-emptive dispute would disarm the gate forever.
--
-- No PII here: an opaque composite id, one of three status strings, a
-- timestamp, and the resolving operator's user id (a handle, nothing more).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_dispute_status (
  dispute_id  TEXT    PRIMARY KEY,   -- payer_id || '.' || payee_id
  status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'upheld', 'rejected')),
  resolved_at INTEGER,
  resolved_by TEXT    REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- translog_leaves  (append-only Merkle transparency log, RFC 6962)
--
-- One row per consequential, NON-PII event: a deal recorded, a participant
-- confirming, a deal reaching a tier, a receipt minted, a referral settled,
-- an ask posted or closed, an invite consumed. The events are the same ones
-- the rest of the board already exposes to the parties involved; this table
-- makes the SEQUENCE of them tamper-evident.
--
-- payload_json is the CANONICAL JSON of the leaf, and it is the whole point
-- of this table that it holds no PII and no raw figures. Every leaf is
--   { seq, type, ts, subject, ...bucketed fields }
-- where `subject` is HMAC(SERVER_PEPPER, "translog-subject" | raw id): a
-- blinded row id, never a handle, never a buyer name. Dollar amounts appear
-- only as $10k buckets ("$120k", "<$10k"), never exact. See lib/translog.ts.
--
-- leaf_hash is the RFC 6962 leaf hash: SHA-256(0x00 || payload_json bytes),
-- hex. It is UNIQUE because `seq` is inside the payload, so no two leaves can
-- collide, and the inclusion-proof endpoint looks a leaf up by this hash.
--
-- seq is a contiguous 1..N sequence (the append path always writes
-- MAX(seq)+1 inside a write transaction), so the tree at size N is exactly
-- the first N rows ordered by seq. Nothing here is ever updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translog_leaves (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  leaf_hash    TEXT    NOT NULL UNIQUE,
  payload_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- translog_heads  (cached Signed Tree Heads)
--
-- The Merkle root is a pure function of translog_leaves, so this table is a
-- CACHE, not a second source of truth: the first time the log is observed at
-- a given tree_size, the root is computed and an STH is signed and stored
-- here, and every later observer at that size is handed the identical STH.
--
-- signed_head is the canonical STH JSON with its Ed25519 signature:
--   { v, logId, treeSize, rootHash, timestamp, signature }
-- signed with a log key derived HKDF-SHA256 from SERVER_PEPPER (label
-- "databoard-translog-v1"). The PUBLIC key is served at
-- /api/translog/pubkey and printed on /transparency/log. root_hash is
-- duplicated out of the JSON for cheap indexing. No PII: a size, two hex
-- digests, a timestamp, a signature.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translog_heads (
  tree_size   INTEGER PRIMARY KEY,
  root_hash   TEXT    NOT NULL,
  signed_head TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- translog_events  (append idempotency map)
--
-- Some events can be triggered more than once for the same logical fact: a
-- receipt is "minted" every time a deal page is rendered, a tier is reached
-- once but the write path may be retried. dedup_key is the logical identity
-- of the event ("receipt_minted:<dealId>:<tier>:<attestedAt>", etc); the
-- append path consults it first and reuses the existing leaf instead of
-- writing a duplicate. It maps a logical event to the leaf that recorded it.
--
-- No PII: an opaque event key built from row ids and enum words, plus the
-- seq and hash of the leaf it points at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translog_events (
  dedup_key  TEXT    PRIMARY KEY,
  leaf_seq   INTEGER NOT NULL REFERENCES translog_leaves(seq),
  leaf_hash  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- exchange_sessions  (commit-encrypt-pay-reveal dataset handoff, Tier A)
--
-- One session per attempted dataset-for-payment handoff riding on a deal. The
-- protocol (lib/exchange.ts, docs/EXCHANGE.md) minimizes counterparty trust
-- for the actual data handoff with client-side crypto: the seller chunks and
-- AEAD-encrypts the dataset in their browser, commits a Merkle manifest over
-- the plaintext chunk hashes AND over the ciphertext chunk hashes plus a
-- salted commitment to the per-deal key, and only reveals the key after the
-- buyer has verified the ciphertext and signaled payment. Every step is a
-- SIGNED, hash-linked event (exchange_events) that both parties' keys gate.
--
-- WHO SIGNS. Each party is PINNED to one Ed25519 signing key at their first
-- step: the seller's key is fixed by the genesis commit (seller_signing_pubkey)
-- and the buyer's by their first event (buyer_signing_pubkey, NULL until then).
-- Every later step by a role must be signed by that role's pinned key, so a
-- valid chain proves the same two keys took every step, in order. The key is
-- the account's own password-derived signing key (lib/e2ee.ts deriveSigningKeys:
-- an Ed25519 pair split from the e2ee seed under a distinct HKDF domain, so it
-- never leaves the device and is the same on any device). When the account has
-- registered that key in the user_signing_keys directory (the receipt path uses
-- the same one), the append path ALSO requires each step to be signed with the
-- registered key, so a step cannot be signed by any key that is not the acting
-- account's own identity key; a legacy account with no registered key falls back
-- to trust-on-first-use on the session-pinned key.
--
-- WHAT THIS ROW HOLDS, and nothing more: the two participant ids (both must be
-- CONFIRMED participants of the deal), the two pinned signing pubkeys, the
-- current state, and COMMITMENTS.
--   plaintext_root / ciphertext_root  RFC 6962 Merkle roots over chunk hashes;
--     hashes of hashes, they reveal nothing about the data.
--   dek_commit                        SHA-256(domain || deal_id || dek_salt ||
--     DEK): a hash of the data-encryption key, never the key.
--   chunk_count / chunk_size          structural, not content.
--   size_bucket                       a COARSE byte-size bucket ("~1 MB"),
--     never the exact size.
-- The server never sees the dataset, the DEK, or any exact figure. It sees
-- commitments, signatures, and state transitions. HONEST BOUND: this makes
-- cheating detectable and evidenced (a party that stops after receiving is
-- provable from the signed chain; chunking caps exposure to one chunk), it
-- does NOT make the exchange atomic. Real atomicity needs an on-chain escrow
-- (Tier B, docs/EXCHANGE.md); it is not built here and is labeled as such.
--
-- demo_ciphertext is the ONE exception to "commitments only", and it is DEMO
-- SCAFFOLDING: a size-capped, opaque AEAD ciphertext blob (base64) the server
-- treats as bytes it cannot read, so the flow is testable end to end in one
-- place. In production the ciphertext moves OFF the platform (directly, or
-- through the E2EE thread as ciphertext) and this column stays NULL. It is not
-- covered by any signature; the buyer verifies it against ciphertext_root.
--
-- head_seq / head_hash pin the tip of the signed event chain, so appending an
-- event is a compare-and-set against the tip the appender last saw.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchange_sessions (
  id              TEXT    PRIMARY KEY,     -- exch_..., chosen by the seller's client, bound into the genesis leaf
  deal_id         TEXT    NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seller_user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_signing_pubkey TEXT   NOT NULL,   -- base64url Ed25519, pinned at the genesis commit
  buyer_signing_pubkey  TEXT,              -- base64url Ed25519, pinned at the buyer's first event; NULL until then
  state           TEXT    NOT NULL         -- committed | ciphertext_ack | payment_signaled | dek_revealed | completed | aborted
                    CHECK (state IN ('committed','ciphertext_ack','payment_signaled','dek_revealed','completed','aborted')),
  plaintext_root  TEXT    NOT NULL,        -- 64-hex Merkle root over plaintext chunk hashes
  ciphertext_root TEXT    NOT NULL,        -- 64-hex Merkle root over ciphertext chunk hashes
  dek_commit      TEXT    NOT NULL,        -- 64-hex SHA-256(domain||deal_id||salt||DEK)
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  size_bucket     TEXT    NOT NULL,        -- coarse byte-size bucket, never exact
  head_seq        INTEGER NOT NULL,        -- seq of the latest event (chain tip)
  head_hash       TEXT    NOT NULL,        -- event_hash of the latest event
  demo_ciphertext TEXT,                    -- DEMO ONLY: opaque AEAD ciphertext blob (base64); NULL in production
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_sessions_deal ON exchange_sessions(deal_id);

-- ---------------------------------------------------------------------------
-- exchange_events  (the signed, hash-linked state transitions)
--
-- One row per step of a session, forming a tamper-evident chain: event N
-- carries prev_hash = event_hash of event N-1 (64 zeros for the genesis
-- commit), and event_hash = SHA-256(payload_json), where payload_json is the
-- CANONICAL JSON of the signed leaf. Reordering, dropping, or altering any
-- event breaks the chain, and each event is Ed25519-SIGNED by the acting
-- party over payload_json, so neither the operator nor the counterparty can
-- forge a step: a valid chain proves the NAMED PARTIES THEMSELVES took each
-- step, in order.
--
-- payload_json is metadata and commitments only, the same fields the session
-- row holds plus the step's own commitment (a ciphertext root the buyer
-- recomputed, a payment-reference COMMITMENT with no amount and no raw ref,
-- an abort reason). No dataset, no DEK, no exact figure, no PII beyond the
-- pseudonymous handles already on the deal. signer_pubkey is the Ed25519 key
-- that signed; the append path checks it equals the acting role's key pinned
-- on the session (seller_signing_pubkey / buyer_signing_pubkey), so a step
-- cannot be signed by a stranger's key or a mid-flow key swap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchange_events (
  session_id    TEXT    NOT NULL REFERENCES exchange_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- 1-based within the session
  type          TEXT    NOT NULL           -- commit | ciphertext_ack | payment_signaled | dek_revealed | completed | abort
                  CHECK (type IN ('commit','ciphertext_ack','payment_signaled','dek_revealed','completed','abort')),
  actor_role    TEXT    NOT NULL CHECK (actor_role IN ('seller','buyer')),
  actor_user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prev_hash     TEXT    NOT NULL,          -- event_hash of seq-1, or 64 zeros for seq 1
  payload_json  TEXT    NOT NULL,          -- canonical JSON of the signed leaf
  event_hash    TEXT    NOT NULL,          -- SHA-256(payload_json), hex
  signer_pubkey TEXT    NOT NULL,          -- base64url Ed25519 public key that signed
  signature     TEXT    NOT NULL,          -- base64url Ed25519 signature over payload_json
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

