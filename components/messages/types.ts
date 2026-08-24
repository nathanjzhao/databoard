/**
 * components/messages/types.ts
 *
 * The wire shapes the messaging API speaks and the client components render.
 * Pure types plus length constants. Nothing here imports server code, so
 * both the route handlers and the client bundle can lean on the same file.
 */

/** Maximum PLAINTEXT length, enforced in the composer before encryption. */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Maximum stored body length for an encrypted envelope. Base64url costs 4/3
 * over the raw bytes and the plaintext can be up to four UTF-8 bytes per
 * character, so a 4000-character message can legitimately reach ~21.4k
 * envelope characters. The server enforces this bound on envelope-shaped
 * bodies and MAX_MESSAGE_LENGTH on plaintext ones.
 */
export const MAX_CIPHERTEXT_LENGTH = 24000;

/** One row in the /messages list. */
export type ThreadSummary = {
  id: string;
  subject: string;
  /** The ask this thread grew out of; null once the ask is deleted. */
  askId: string | null;
  askTitle: string | null;
  /** Usernames of everyone in the thread except the viewer. */
  others: string[];
  /** The deal this thread is the deal room for, or null. Drives the tag. */
  dealId: string | null;
  /**
   * Last message body for the preview line. May be an encrypted envelope;
   * the list decrypts it client-side and shows a placeholder until it can.
   */
  lastBody: string | null;
  lastSender: string | null;
  /** last_message_at, falling back to the thread's created_at when empty. */
  lastAt: number;
  /** True when someone else has said something since the viewer last looked. */
  unread: boolean;
  /** True when this thread has installed encryption keys. */
  encrypted: boolean;
  /** The viewer's wrapped thread key, for decrypting the preview. */
  wrappedKey: string | null;
  ephPubkey: string | null;
};

/** One message as it travels to the client. */
export type WireMessage = {
  id: string;
  /** Sender's username. The only identity anyone gets. */
  sender: string;
  /** True when the viewer sent it. Computed server-side per request. */
  mine: boolean;
  /** Envelope (e2ee threads) or plaintext (legacy / unencrypted threads). */
  body: string;
  createdAt: number;
};

/** One seat's public encryption identity, for key setup and display. */
export type ParticipantKey = {
  username: string;
  /** base64url X25519 public key, or null when the account has none yet. */
  pubkey: string | null;
};

/**
 * The thread's encryption posture, computed server-side per request.
 *   keysExist        thread_keys rows are installed; bodies are envelopes.
 *   myWrappedKey/... the viewer's own wrapped copy of the thread key.
 *   participants     every seat (the viewer included) with its public key,
 *                    so the first client to open a keyless thread can wrap
 *                    the thread key for the whole table.
 */
export type ThreadEncryption = {
  keysExist: boolean;
  myWrappedKey: string | null;
  myEphPubkey: string | null;
  participants: ParticipantKey[];
};

/** Everything the thread view needs. */
export type ThreadDetail = {
  id: string;
  subject: string;
  askId: string | null;
  askTitle: string | null;
  others: string[];
  /** The deal this thread is the deal room for, or null. */
  dealId: string | null;
  /** Messages at or after the `since` cursor, oldest first. */
  messages: WireMessage[];
  /** Server clock when this payload was assembled. */
  fetchedAt: number;
  encryption: ThreadEncryption;
};
