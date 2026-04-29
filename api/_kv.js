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
//   session:wave:{sessionId}              → full session JSON
//   session:so-lock:{soId}:{locationId}   → sessionId that currently
//                                            owns this SO at this loc
//
// Lock keys are LOCATION-SCOPED so two pickers at different warehouses
// can simultaneously pick different lines of the same SO. See
// PRD-Location-Scoped-SO-Fulfillment.md.
//
// During the migration window we also tolerate the old un-scoped key
// (`session:so-lock:{soId}`) so a wave that started before the deploy
// completes cleanly. Remove the legacy fallback after 48h of clean
// operation post-deploy (search for "LEGACY_LOCK").
// ═══════════════════════════════════════════════════════════
export const KEY_WAVE_SESSION = (sessionId) => `session:wave:${sessionId}`;
export const KEY_SO_LOCK = (soId, locationId) => `session:so-lock:${soId}:${locationId}`;
// LEGACY_LOCK — pre-location-scoping format. Read-only fallback during
// the 48h migration window so old in-flight waves complete cleanly.
export const KEY_SO_LOCK_LEGACY = (soId) => `session:so-lock:${soId}`;

export const newWaveSessionId = () => `wave_${crypto.randomBytes(8).toString("hex")}`;

export async function getWaveSession(sessionId) {
  return await kv.get(KEY_WAVE_SESSION(sessionId));
}

export async function writeWaveSession(session) {
  const ttl = getSessionTtlSeconds();
  const locationId = session.locationId != null ? String(session.locationId) : "";
  if (!locationId) throw new Error("writeWaveSession: session.locationId is required for location-scoped locks");
  const writes = [kv.set(KEY_WAVE_SESSION(session.sessionId), session, { ex: ttl })];
  for (const soId of session.soIds || []) {
    writes.push(kv.set(KEY_SO_LOCK(soId, locationId), session.sessionId, { ex: ttl }));
  }
  await Promise.all(writes);
}

export async function deleteWaveSession(session) {
  const locationId = session.locationId != null ? String(session.locationId) : "";
  const deletes = [kv.del(KEY_WAVE_SESSION(session.sessionId))];
  for (const soId of session.soIds || []) {
    if (locationId) deletes.push(kv.del(KEY_SO_LOCK(soId, locationId)));
    // LEGACY_LOCK — clear any pre-deploy lock at the unscoped key so it
    // can't strand the SO. Cheap; safe to remove with the read fallback.
    deletes.push(kv.del(KEY_SO_LOCK_LEGACY(soId)));
  }
  await Promise.all(deletes);
}

// Returns the sessionId currently owning {soId, locationId}, or null.
// Per H-4, falls back to the legacy un-scoped key if no scoped lock
// exists; this catches in-flight waves that started before the deploy.
export async function getSOLock(soId, locationId) {
  if (!locationId) throw new Error("getSOLock: locationId is required");
  const scoped = await kv.get(KEY_SO_LOCK(soId, locationId));
  if (scoped) return scoped;
  // LEGACY_LOCK — fall back to pre-deploy key. Remove this branch once
  // the 48h migration window has passed.
  return await kv.get(KEY_SO_LOCK_LEGACY(soId));
}

// Deletes both the scoped lock and the legacy un-scoped lock for an
// SO. Used when an SO is removed from a wave or the wave is fulfilled.
export async function deleteSOLock(soId, locationId) {
  const ops = [];
  if (locationId) ops.push(kv.del(KEY_SO_LOCK(soId, locationId)));
  // LEGACY_LOCK — clean up pre-deploy keys so they don't strand the
  // SO after the new code releases the scoped lock. Safe to remove
  // alongside the read fallback above.
  ops.push(kv.del(KEY_SO_LOCK_LEGACY(soId)));
  await Promise.all(ops);
}
