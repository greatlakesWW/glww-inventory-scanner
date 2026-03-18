// ═══════════════════════════════════════════════════════════
// ACTIVITY LOG — IndexedDB-backed audit trail
// ═══════════════════════════════════════════════════════════

const DB_NAME = "glww_activity_log";
const STORE_NAME = "entries";
const DB_VERSION = 1;

// In-memory fallback when IndexedDB is unavailable
let memoryFallback = null;

// ── DB CONNECTION ──────────────────────────────────────────
let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("module", "module", { unique: false });
          store.createIndex("action", "action", { unique: false });
          store.createIndex("sourceDocument", "sourceDocument", { unique: false });
          store.createIndex("netsuiteRecord", "netsuiteRecord", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("IndexedDB open failed, using in-memory fallback");
        memoryFallback = [];
        reject(request.error);
      };
    } catch (e) {
      console.warn("IndexedDB unavailable, using in-memory fallback");
      memoryFallback = [];
      reject(e);
    }
  });
  return dbPromise;
}

// Initialize on import — don't block, just kick off
getDB().catch(() => { memoryFallback = memoryFallback || []; });

// ── HELPERS ────────────────────────────────────────────────
function tx(mode) {
  return getDB().then(db => {
    const t = db.transaction(STORE_NAME, mode);
    return t.objectStore(STORE_NAME);
  });
}

// ── WRITE ──────────────────────────────────────────────────
export async function logActivity(entry) {
  const record = {
    ...entry,
    timestamp: new Date().toISOString(),
    status: entry.status || "success",
    sourceDocument: entry.sourceDocument || null,
    netsuiteRecord: entry.netsuiteRecord || null,
    netsuiteRecordId: entry.netsuiteRecordId || null,
    items: entry.items || [],
    error: entry.error || null,
  };

  try {
    if (memoryFallback !== null) {
      record.id = memoryFallback.length + 1;
      memoryFallback.push(record);
      return;
    }
    const store = await tx("readwrite");
    await new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // Fallback to memory if write fails
    if (memoryFallback === null) memoryFallback = [];
    record.id = memoryFallback.length + 1;
    memoryFallback.push(record);
    console.warn("logActivity fell back to memory:", e);
  }
}

// ── QUERY ──────────────────────────────────────────────────
export async function queryLog({ module, action, search, startDate, endDate, limit = 100, offset = 0 } = {}) {
  try {
    if (memoryFallback !== null) {
      return queryMemory({ module, action, search, startDate, endDate, limit, offset });
    }

    const store = await tx("readonly");
    const all = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Sort newest first
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Apply filters
    const filtered = applyFilters(all, { module, action, search, startDate, endDate });
    const total = filtered.length;
    const entries = filtered.slice(offset, offset + limit);
    return { entries, total };
  } catch (e) {
    console.warn("queryLog error:", e);
    return { entries: [], total: 0 };
  }
}

function applyFilters(entries, { module, action, search, startDate, endDate }) {
  let result = entries;

  if (module) {
    result = result.filter(e => e.module === module);
  }
  if (action) {
    if (action === "errors-only") {
      result = result.filter(e => e.status === "error");
    } else {
      result = result.filter(e => e.action === action);
    }
  }
  if (startDate) {
    result = result.filter(e => e.timestamp >= startDate);
  }
  if (endDate) {
    result = result.filter(e => e.timestamp <= endDate);
  }
  if (search) {
    const lower = search.toLowerCase();
    result = result.filter(e => {
      const fields = [
        e.sourceDocument, e.netsuiteRecord, e.details,
        ...(e.items || []).map(i => i.sku),
      ].filter(Boolean);
      return fields.some(f => f.toLowerCase().includes(lower));
    });
  }

  return result;
}

function queryMemory({ module, action, search, startDate, endDate, limit, offset }) {
  const sorted = [...memoryFallback].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const filtered = applyFilters(sorted, { module, action, search, startDate, endDate });
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
}

// ── EXPORT CSV ─────────────────────────────────────────────
export async function exportLogCSV(filters = {}) {
  const { entries } = await queryLog({ ...filters, limit: 999999, offset: 0 });
  const header = "Timestamp,Module,Action,Status,Source Document,NS Record,NS Record ID,Details,Items,Error\n";
  const rows = entries.map(e => {
    const items = (e.items || []).map(i => `${i.sku}:${i.qty}`).join("; ");
    return [
      `"${e.timestamp}"`,
      `"${e.module || ""}"`,
      `"${e.action || ""}"`,
      `"${e.status || ""}"`,
      `"${(e.sourceDocument || "").replace(/"/g, '""')}"`,
      `"${(e.netsuiteRecord || "").replace(/"/g, '""')}"`,
      `"${e.netsuiteRecordId || ""}"`,
      `"${(e.details || "").replace(/"/g, '""')}"`,
      `"${items}"`,
      `"${(e.error || "").replace(/"/g, '""')}"`,
    ].join(",");
  });
  return header + rows.join("\n");
}

// ── COUNT ──────────────────────────────────────────────────
export async function getLogCount() {
  try {
    if (memoryFallback !== null) return memoryFallback.length;
    const store = await tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return memoryFallback ? memoryFallback.length : 0;
  }
}

// ── CLEAR ──────────────────────────────────────────────────
export async function clearLog() {
  try {
    if (memoryFallback !== null) {
      memoryFallback = [];
      return;
    }
    const store = await tx("readwrite");
    await new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    if (memoryFallback !== null) memoryFallback = [];
    console.warn("clearLog error:", e);
  }
}
