/**
 * components/messages/types.ts
 *
 * The wire shapes the messaging API speaks and the client components render.
 * Pure types plus one length constant. Nothing here imports server code, so
 * both the route handlers and the client bundle can lean on the same file.
 */

export const MAX_MESSAGE_LENGTH = 4000;

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
  /** Last message body and its sender's username, for the preview line. */
  lastBody: string | null;
  lastSender: string | null;
  /** last_message_at, falling back to the thread's created_at when empty. */
  lastAt: number;
  /** True when someone else has said something since the viewer last looked. */
  unread: boolean;
};

/** One message as it travels to the client. */
export type WireMessage = {
  id: string;
  /** Sender's username. The only identity anyone gets. */
  sender: string;
  /** True when the viewer sent it. Computed server-side per request. */
  mine: boolean;
  body: string;
  createdAt: number;
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
};
