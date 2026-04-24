import { kv } from "@vercel/kv";
import crypto from "crypto";

// ═══════════════════════════════════════════════════════════
// KV helpers for pick sessions
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.3
// ═══════════════════════════════════════════════════════════

// ─── Key format ───
export const KEY_SESSION_BY_TO = (toId) => `session:to:${toId}`;
export const KEY_ID_TO_TO = (sessionId) => `session:id:${sessionId}`;

// ─── TTL (48h default per §3.2) ───
export const getSessionTtlSeconds = () => {
  const raw = Number(process.env.SESSION_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 172800;
};

// ─── ID generators ───
// sessionId: sess_ + 16 hex chars (8 random bytes)
// eventId:   evt_  + 12 hex chars (6 random bytes) — shorter since they're high-volume
export const newSessionId = () => `sess_${crypto.randomBytes(8).toString("hex")}`;
export const newEventId = () => `evt_${crypto.randomBytes(6).toString("hex")}`;

// ─── Reads ───
export async function getSessionByToId(toId) {
  return await kv.get(KEY_SESSION_BY_TO(toId));
}

export async function getSessionBySessionId(sessionId) {
  const toId = await kv.get(KEY_ID_TO_TO(sessionId));
  if (!toId) return null;
  const session = await kv.get(KEY_SESSION_BY_TO(toId));
  return session || null;
}

// ─── Writes ───
// Writes the session JSON under both keys with refreshed TTL on every write
// so active sessions don't expire during normal use.
export async function writeSession(session) {
  const ttl = getSessionTtlSeconds();
  await Promise.all([
    kv.set(KEY_SESSION_BY_TO(session.toId), session, { ex: ttl }),
    kv.set(KEY_ID_TO_TO(session.sessionId), session.toId, { ex: ttl }),
  ]);
}

// ─── Deletes ───
export async function deleteSession(session) {
  await Promise.all([
    kv.del(KEY_SESSION_BY_TO(session.toId)),
    kv.del(KEY_ID_TO_TO(session.sessionId)),
  ]);
}

// ═══════════════════════════════════════════════════════════
// Wave-pick sessions (Sales Orders — many SOs per session)
//
// Shape differs from TO sessions because a wave holds an array of
// soIds that can grow/shrink during picking:
//   session:wave:{sessionId} → full session JSON
//   session:so-lock:{soId}   → sessionId that currently owns this SO
//
// The SO lock prevents two pickers from accidentally waving the same
// SO at once, and powers takeover/warning UX.
// ═══════════════════════════════════════════════════════════
export const KEY_WAVE_SESSION = (sessionId) => `session:wave:${sessionId}`;
export const KEY_SO_LOCK      = (soId)      => `session:so-lock:${soId}`;

export const newWaveSessionId = () => `wave_${crypto.randomBytes(8).toString("hex")}`;

export async function getWaveSession(sessionId) {
  return await kv.get(KEY_WAVE_SESSION(sessionId));
}

export async function writeWaveSession(session) {
  const ttl = getSessionTtlSeconds();
  const writes = [kv.set(KEY_WAVE_SESSION(session.sessionId), session, { ex: ttl })];
  for (const soId of session.soIds || []) {
    writes.push(kv.set(KEY_SO_LOCK(soId), session.sessionId, { ex: ttl }));
  }
  await Promise.all(writes);
}

export async function deleteWaveSession(session) {
  const deletes = [kv.del(KEY_WAVE_SESSION(session.sessionId))];
  for (const soId of session.soIds || []) {
    deletes.push(kv.del(KEY_SO_LOCK(soId)));
  }
  await Promise.all(deletes);
}

export async function getSOLock(soId) {
  return await kv.get(KEY_SO_LOCK(soId));
}
