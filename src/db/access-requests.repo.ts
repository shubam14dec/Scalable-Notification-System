import { createHash } from 'node:crypto';
import { pool } from './pool';

/**
 * B1 — the beta gate's one table.
 *
 * Its own file rather than more functions in `accounts.repo.ts`, because an
 * access request is deliberately NOT an account: it exists before any user,
 * organization, environment or key does, it is keyed on a bare mailbox, and its
 * whole life ends the moment a user row appears. Keeping it apart is what stops
 * the accounts repo from growing a second, pre-account notion of identity.
 *
 * Every state transition is a CONDITIONAL update that returns the row it
 * changed (or nothing). Callers read null as "the row was not in the state you
 * assumed" and answer accordingly — no read-then-write windows, so two
 * operators clicking Approve and Decline at the same moment, or two browsers
 * racing one invite code, cannot both win.
 */

export interface AccessRequest {
  id: string;
  email: string;
  name: string;
  use_case: string;
  status: 'pending' | 'approved' | 'declined';
  invite_code_hash: string | null;
  invite_expires_at: string | null;
  consumed_at: string | null;
  created_at: string;
  decided_at: string | null;
}

/** Invite codes live hashed, exactly like reset tokens and api keys. */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function getAccessRequestByEmail(email: string): Promise<AccessRequest | null> {
  const { rows } = await pool.query('select * from access_requests where email = $1', [
    email.trim().toLowerCase(),
  ]);
  return rows[0] ?? null;
}

export async function getAccessRequestById(id: string): Promise<AccessRequest | null> {
  const { rows } = await pool.query('select * from access_requests where id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * A brand-new request. `on conflict (email) do nothing` returns null when the
 * address got a row between the caller's lookup and this insert — the caller
 * treats that as the no-op it is, so a double-submit can never produce two
 * rows or two operator emails.
 */
export async function insertAccessRequest(
  email: string,
  name: string,
  useCase: string,
): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `insert into access_requests (email, name, use_case)
     values ($1, $2, $3)
     on conflict (email) do nothing
     returning *`,
    [email.trim().toLowerCase(), name, useCase],
  );
  return rows[0] ?? null;
}

/**
 * A previously DECLINED address asking again: the row goes back to pending with
 * the new name and use case, a fresh `created_at` (it is a new ask, and the
 * Requests page sorts by it) and the decision cleared.
 *
 * Guarded on `status = 'declined'` so this can never quietly reopen a pending
 * or approved row — the caller only reaches it when the row it read was
 * declined, and the guard is what makes that read safe to act on.
 */
export async function reopenDeclinedRequest(
  email: string,
  name: string,
  useCase: string,
): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `update access_requests
        set status = 'pending',
            name = $2,
            use_case = $3,
            created_at = now(),
            decided_at = null,
            invite_code_hash = null,
            invite_expires_at = null
      where email = $1 and status = 'declined'
      returning *`,
    [email.trim().toLowerCase(), name, useCase],
  );
  return rows[0] ?? null;
}

export async function listAccessRequests(
  status: 'pending' | 'approved' | 'declined',
): Promise<AccessRequest[]> {
  const { rows } = await pool.query(
    'select * from access_requests where status = $1 order by created_at desc',
    [status],
  );
  return rows;
}

/**
 * Approve (or RE-approve) a request: stamp a fresh invite digest and expiry on
 * it and mark it approved.
 *
 * Re-approval is the resend path and it deliberately OVERWRITES the digest — an
 * invite that was lost, or that expired in an inbox, must die when a new one is
 * minted, or "resend" would quietly leave two live codes for one seat.
 *
 * Guarded on `consumed_at is null` and on the two states an approval may come
 * from: a consumed row is spent forever, and a declined row must travel back
 * through pending (a new request) rather than being flipped by an operator who
 * is looking at a stale list.
 */
export async function approveAccessRequest(
  id: string,
  inviteCodeHash: string,
  expiresAt: Date,
): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `update access_requests
        set status = 'approved',
            invite_code_hash = $2,
            invite_expires_at = $3,
            decided_at = now()
      where id = $1
        and consumed_at is null
        and status in ('pending', 'approved')
      returning *`,
    [id, inviteCodeHash, expiresAt.toISOString()],
  );
  return rows[0] ?? null;
}

/** Decline a PENDING request. Null = it was not pending (already decided). */
export async function declineAccessRequest(id: string): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `update access_requests
        set status = 'declined', decided_at = now()
      where id = $1 and status = 'pending'
      returning *`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The signup gate's lookup: the live invite behind a raw code, or null.
 *
 * Approved, unconsumed and unexpired are checked HERE, in SQL, against the
 * database clock — so "is this invite still good?" is one indivisible question
 * with one answer, and the caller has no branch it could get subtly wrong.
 */
export async function findLiveInvite(code: string): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `select * from access_requests
      where invite_code_hash = $1
        and status = 'approved'
        and consumed_at is null
        and invite_expires_at > now()`,
    [hashInviteCode(code)],
  );
  return rows[0] ?? null;
}

/**
 * The Google door's lookup: a live invite held by this ADDRESS.
 *
 * A Google sign-in never carries a code — the person clicks "Continue with
 * Google", not a link out of our email — so the mailbox Google vouches for is
 * the only thing that can be matched, and `email_verified` (see
 * routes/google-auth.ts) is what makes that safe to trust.
 */
export async function findLiveInviteForEmail(email: string): Promise<AccessRequest | null> {
  const { rows } = await pool.query(
    `select * from access_requests
      where email = $1
        and status = 'approved'
        and consumed_at is null
        and invite_expires_at > now()`,
    [email.trim().toLowerCase()],
  );
  return rows[0] ?? null;
}

/**
 * Spend an invite. ATOMIC and single-use: `consumed_at is null` in the WHERE
 * clause means the database, not the application, decides who won — two
 * concurrent signups on one code both reach this line and exactly one gets a
 * row back. The loser is turned away with the same refusal as an invented code.
 */
export async function consumeAccessRequest(id: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update access_requests
        set consumed_at = now()
      where id = $1 and consumed_at is null
      returning id`,
    [id],
  );
  return rows.length > 0;
}
