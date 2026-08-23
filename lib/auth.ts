/**
 * lib/auth.ts
 *
 * Accounts and sessions. Server-only, async end to end.
 *
 * An account is: username, scrypt password hash, an org-or-individual bit,
 * and a contact blind index. Those four columns are the complete residue of
 * signup. The real name, the org name and the raw contact were attested in
 * the stateless challenge (lib/verify.ts) and discarded in the same request.
 *
 * There is no password reset because there is nothing to send one to. The
 * signup screen says so before anyone commits to that trade.
 */

import { getDb, now } from "./db.ts";
import {
  contactBlindIndex,
  hashPassword,
  newId,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "./crypto.ts";
import { SESSION_COOKIE } from "./gate.ts";
import type { AccountType } from "./verify.ts";

export { SESSION_COOKIE };
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type SessionUser = {
  id: string;
  username: string;
  accountType: AccountType;
  createdAt: number;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  account_type: AccountType;
  contact_blind_index: string;
  created_at: number;
};

function rowToSessionUser(row: Record<string, unknown>): SessionUser {
  const r = row as unknown as UserRow;
  return {
    id: String(r.id),
    username: String(r.username),
    accountType: r.account_type === "individual" ? "individual" : "org",
    createdAt: Number(r.created_at),
  };
}

/* ------------------------------------------------------------- usernames */

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{2,23})$/;

export function normalizeUsername(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

export function usernameProblem(raw: string): string | null {
  const u = normalizeUsername(raw);
  if (u.length < 3) return "Pick at least 3 characters.";
  if (u.length > 24) return "24 characters max.";
  if (!USERNAME_RE.test(u)) {
    return "Lowercase letters, numbers, dashes and underscores. Start with a letter or number.";
  }
  return null;
}

export async function usernameTaken(raw: string): Promise<boolean> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT 1 FROM users WHERE username = ?`,
    args: [normalizeUsername(raw)],
  });
  return rs.rows.length > 0;
}

/* ---------------------------------------------------------------- signup */

export type CreateUserResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: "username_taken" | "contact_taken" | "bad_username" };

/**
 * Creates an account from a username, a password, the attested account type,
 * and an already-verified contact.
 *
 * `normalizedContact` is turned into a blind index here and then goes out of
 * scope. It is never passed to the database in any other form. Callers hold
 * it for the length of one request handler and no longer. These four values
 * are the ONLY things signup ever persists.
 */
export async function createUser(
  username: string,
  password: string,
  accountType: AccountType,
  normalizedContact: string,
): Promise<CreateUserResult> {
  const u = normalizeUsername(username);
  if (usernameProblem(u)) return { ok: false, error: "bad_username" };

  const row: UserRow = {
    id: newId("usr"),
    username: u,
    password_hash: hashPassword(password),
    account_type: accountType,
    contact_blind_index: contactBlindIndex(normalizedContact),
    created_at: now(),
  };

  const db = await getDb();
  try {
    await db.execute({
      sql: `INSERT INTO users (id, username, password_hash, account_type, contact_blind_index, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.username,
        row.password_hash,
        row.account_type,
        row.contact_blind_index,
        row.created_at,
      ],
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("users.username")) return { ok: false, error: "username_taken" };
    if (msg.includes("users.contact_blind_index")) {
      return { ok: false, error: "contact_taken" };
    }
    throw err;
  }

  return { ok: true, user: rowToSessionUser(row as unknown as Record<string, unknown>) };
}

/* ----------------------------------------------------------------- login */

export async function findUserByUsername(username: string): Promise<SessionUser | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM users WHERE username = ?`,
    args: [normalizeUsername(username)],
  });
  return rs.rows[0] ? rowToSessionUser(rs.rows[0]) : null;
}

export async function getUserById(id: string): Promise<SessionUser | null> {
  const db = await getDb();
  const rs = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [id] });
  return rs.rows[0] ? rowToSessionUser(rs.rows[0]) : null;
}

/** Decoy hash so a miss burns the same scrypt time as a wrong password. */
let decoyHash: string | null = null;
function getDecoyHash(): string {
  if (!decoyHash) decoyHash = hashPassword("decoy-password-for-timing");
  return decoyHash;
}

/** Returns the user on a correct username + password, null otherwise. */
export async function verifyLogin(
  username: string,
  password: string,
): Promise<SessionUser | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM users WHERE username = ?`,
    args: [normalizeUsername(username)],
  });
  const row = rs.rows[0];
  if (!row) {
    // Burn roughly the same time as a real scrypt check so the response time
    // does not answer "does this username exist".
    verifyPassword(password, getDecoyHash());
    return null;
  }
  if (!verifyPassword(password, String(row.password_hash))) return null;
  return rowToSessionUser(row);
}

/* -------------------------------------------------------------- sessions */

export type IssuedSession = { token: string; expiresAt: number };

/** Mints a session. The raw token goes in the cookie; only sha256 is stored. */
export async function createSession(userId: string): Promise<IssuedSession> {
  const token = randomToken(32);
  const createdAt = now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [sha256Hex(token), userId, createdAt, expiresAt],
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM sessions WHERE token_hash = ?`,
    args: [sha256Hex(token)],
  });
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: `DELETE FROM sessions WHERE user_id = ?`, args: [userId] });
}

/** Resolve a raw session token to a user, dropping the row if it has expired. */
export async function getUserBySessionToken(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await getDb();
  const hash = sha256Hex(token);
  const rs = await db.execute({
    sql: `SELECT u.*, s.expires_at AS session_expires_at
            FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ?`,
    args: [hash],
  });
  const row = rs.rows[0];
  if (!row) return null;
  if (Number(row.session_expires_at) < now()) {
    await db.execute({ sql: `DELETE FROM sessions WHERE token_hash = ?`, args: [hash] });
    return null;
  }
  return rowToSessionUser(row);
}

export async function pruneExpiredSessions(): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `DELETE FROM sessions WHERE expires_at < ?`,
    args: [now()],
  });
  return rs.rowsAffected;
}

/* ------------------------------------------------------- request binding */

/**
 * Cookie options for the session cookie. Route handlers apply these to a
 * NextResponse; nothing here reaches for request state.
 */
export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  };
}

export function clearedCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  };
}

/**
 * The one function most pages call: who is looking at this request. Returns
 * null when signed out, and null (rather than throwing) when no database is
 * configured, so public pages still render on a bare deployment. Reading
 * cookies opts the caller into dynamic rendering, which is correct for every
 * page on this board. The middleware only checks that the cookie EXISTS; this
 * is the real check every page and API must make.
 *
 * next/headers is imported lazily so that this module stays loadable from a
 * plain node script (scripts/seed.ts) that has no request context.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await getUserBySessionToken(token);
  } catch {
    // DbNotConfiguredError or a transient failure: treat as signed out.
    return null;
  }
}

/** Same, but throws. For routes that have already checked the user is signed in. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in.");
  return user;
}
