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
