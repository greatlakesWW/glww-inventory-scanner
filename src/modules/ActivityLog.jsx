import { useState, useEffect, useCallback, useRef } from "react";
import { S, FONT, ANIMATIONS, mono, fadeIn, Logo } from "../shared";
import { queryLog, exportLogCSV, getLogCount, clearLog } from "../activityLog";

// ═══════════════════════════════════════════════════════════
// ACTION LABELS & MODULE CONFIG
// ═══════════════════════════════════════════════════════════
const MODULE_OPTIONS = [
  { value: "", label: "All Modules" },
  { value: "smart-fulfillment", label: "Smart Fulfillment" },
  { value: "transfer-orders", label: "Transfer Orders" },
  { value: "item-receipts", label: "Item Receipts" },
  { value: "inventory-count", label: "Inventory Count" },
  { value: "bin-transfer", label: "Bin Transfer" },
  { value: "create-inventory", label: "Create Inventory" },
  { value: "item-lookup", label: "Item Lookup" },
];

const ACTION_OPTIONS = {
  "": [{ value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" }],
  "smart-fulfillment": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "wave-built", label: "Wave Built" },
    { value: "fulfillment-created", label: "Fulfillment Created" },
    { value: "fulfillment-failed", label: "Fulfillment Failed" },
  ],
  "transfer-orders": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "to-fulfillment-created", label: "TO Fulfillment Created" },
    { value: "to-receipt-created", label: "TO Receipt Created" },
    { value: "to-fulfillment-failed", label: "TO Fulfillment Failed" },
    { value: "to-receipt-failed", label: "TO Receipt Failed" },
  ],
  "item-receipts": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "item-receipt-created", label: "Receipt Created" },
    { value: "transfer-order-auto-created", label: "TO Auto-Created" },
    { value: "bin-transfer-completed", label: "Bin Transfer" },
    { value: "item-receipt-failed", label: "Receipt Failed" },
    { value: "transfer-order-failed", label: "TO Failed" },
    { value: "bin-transfer-failed", label: "Bin Transfer Failed" },
  ],
  "inventory-count": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "count-exported", label: "Count Exported" },
    { value: "count-adjustment-exported", label: "Adjustment Exported" },
  ],
  "bin-transfer": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "bin-transfer-completed", label: "Transfer Completed" },
    { value: "bin-transfer-failed", label: "Transfer Failed" },
  ],
  "create-inventory": [
    { value: "", label: "All Actions" }, { value: "errors-only", label: "Errors Only" },
    { value: "inventory-created", label: "Inventory Created" },
    { value: "inventory-create-failed", label: "Create Failed" },
  ],
  "item-lookup": [
    { value: "", label: "All Actions" },
    { value: "item-lookup", label: "Item Lookup" },
  ],
};

const ACTION_LABELS = {
  "wave-built": "Wave Built",
  "fulfillment-created": "Fulfillment Created",
  "fulfillment-failed": "Fulfillment Failed",
  "to-fulfillment-created": "TO Fulfillment Created",
  "to-receipt-created": "TO Receipt Created",
  "to-fulfillment-failed": "TO Fulfillment Failed",
  "to-receipt-failed": "TO Receipt Failed",
  "item-receipt-created": "Item Receipt Created",
  "item-receipt-failed": "Item Receipt Failed",
  "transfer-order-auto-created": "TO Auto-Created",
  "transfer-order-failed": "TO Creation Failed",
  "bin-transfer-completed": "Bin Transfer",
  "bin-transfer-failed": "Bin Transfer Failed",
  "count-exported": "Count Exported",
  "count-adjustment-exported": "Adjustment Exported",
  "inventory-created": "Inventory Created",
  "inventory-create-failed": "Inventory Create Failed",
  "item-lookup": "Item Lookup",
};

const PAGE_SIZE = 50;

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function formatTimestamp(iso) {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  if (isToday) {
    const diff = now - d;
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix = d.toDateString() === yesterday.toDateString() ? "Yesterday" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${prefix}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function getDateRange(range) {
  if (!range || range === "all") return {};
  const now = new Date();
  let start;
  if (range === "today") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (range === "7d") {
    start = new Date(now); start.setDate(start.getDate() - 7);
  } else if (range === "30d") {
    start = new Date(now); start.setDate(start.getDate() - 30);
  }
  return start ? { startDate: start.toISOString() } : {};
}

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function ActivityLog({ onBack }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [entryCount, setEntryCount] = useState(0);
  const [loaded, setLoaded] = useState(0);

  // Filters
  const [moduleFilter, setModuleFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const searchTimeoutRef = useRef(null);

  // Expanded entry
  const [expandedId, setExpandedId] = useState(null);

  // Export
  const [showExport, setShowExport] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  // Clear
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearCountdown, setClearCountdown] = useState(0);

  // ── LOAD ENTRIES ──
  const loadEntries = useCallback(async (reset = false) => {
    const offset = reset ? 0 : loaded;
    const filters = {
      module: moduleFilter || undefined,
      action: actionFilter || undefined,
      search: search || undefined,
      ...getDateRange(dateRange),
      limit: PAGE_SIZE,
      offset,
    };
    const result = await queryLog(filters);
    if (reset) {
      setEntries(result.entries);
      setLoaded(result.entries.length);
    } else {
      setEntries(prev => [...prev, ...result.entries]);
      setLoaded(prev => prev + result.entries.length);
    }
    setTotal(result.total);
  }, [moduleFilter, actionFilter, search, dateRange, loaded]);

  // Initial load + reload on filter changes
  useEffect(() => {
    loadEntries(true);
    getLogCount().then(setEntryCount);
  }, [moduleFilter, actionFilter, dateRange]);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      loadEntries(true);
    }, 300);
    return () => clearTimeout(searchTimeoutRef.current);
  }, [search]);

  // Reset action when module changes
  useEffect(() => { setActionFilter(""); }, [moduleFilter]);

  // ── EXPORT ──
  const handleExport = async (filtered = false) => {
    const filters = filtered ? {
      module: moduleFilter || undefined,
      action: actionFilter || undefined,
      search: search || undefined,
      ...getDateRange(dateRange),
    } : {};
    const csv = await exportLogCSV(filters);
    const blob = new Blob([csv], { type: "text/csv" });
    const file = new File([csv], `activity_log_${new Date().toISOString().slice(0, 10)}.csv`, { type: "text/csv" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ title: "GLWW Activity Log", files: [file] }); } catch (e) { if (e.name !== "AbortError") downloadBlob(blob); }
    } else {
      downloadBlob(blob);
    }
    setShowExport(false);
  };

  const downloadBlob = (blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `activity_log_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleEmailExport = async (filtered = false) => {
    if (!emailTo.trim()) return;
    setEmailSending(true);
    try {
      const filters = filtered ? {
        module: moduleFilter || undefined,
        action: actionFilter || undefined,
        search: search || undefined,
        ...getDateRange(dateRange),
      } : {};
      const csv = await exportLogCSV(filters);
      const resp = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: emailTo.trim(),
          subject: `GLWW Activity Log Export — ${new Date().toISOString().slice(0, 10)}`,
          body: `Activity log export with ${total} entries.`,
          filename: `activity_log_${new Date().toISOString().slice(0, 10)}.csv`,
          csv,
        }),
      });
      if (!resp.ok) throw new Error("Send failed");
      setShowExport(false);
    } catch (e) { console.error("Email export failed:", e); }
    finally { setEmailSending(false); }
  };

  // ── CLEAR ──
  const handleClearStart = () => {
    setShowClearConfirm(true);
    setClearCountdown(3);
  };

  useEffect(() => {
    if (clearCountdown > 0) {
      const t = setTimeout(() => setClearCountdown(c => c - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [clearCountdown]);

  const handleClearConfirm = async () => {
    await clearLog();
    setShowClearConfirm(false);
    setClearCountdown(0);
    setEntries([]);
    setTotal(0);
    setLoaded(0);
    setEntryCount(0);
  };

  // ── RENDER ──
  const actionOptions = ACTION_OPTIONS[moduleFilter] || ACTION_OPTIONS[""];
  const hasMore = loaded < total;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* HEADER */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700 }}>Activity Log</span>
          <span style={{
            fontSize: 11, fontWeight: 700, ...mono, padding: "2px 8px",
            borderRadius: 10, background: "rgba(59,130,246,0.15)", color: "#60a5fa",
          }}>
            {entryCount.toLocaleString()}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            style={{ ...S.btnSm, fontSize: 11, padding: "6px 10px", minHeight: 32 }}
            onClick={() => setShowExport(!showExport)}
          >⬇ Export</button>
          <button style={S.btnSm} onClick={onBack}>← Home</button>
        </div>
      </div>

      {/* EXPORT PANEL */}
      {showExport && (
        <div style={{ ...fadeIn, padding: "12px 16px", background: "rgba(59,130,246,0.04)", borderBottom: "1px solid rgba(59,130,246,0.15)" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={() => handleExport(false)}>📥 Export All</button>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={() => handleExport(true)}>📥 Export Filtered</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={{ ...S.inp, flex: 1, fontSize: 13, padding: "8px 12px", minHeight: 36 }}
              placeholder="Email to..."
              value={emailTo}
              onChange={e => setEmailTo(e.target.value)}
            />
            <button
              style={{ ...S.btnSm, flexShrink: 0, opacity: emailTo.trim() ? 1 : 0.4 }}
              onClick={() => handleEmailExport(true)}
              disabled={!emailTo.trim() || emailSending}
            >{emailSending ? "…" : "📧"}</button>
          </div>
        </div>
      )}

      {/* FILTER BAR */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div
          onClick={() => setShowFilters(!showFilters)}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", touchAction: "manipulation", padding: "4px 0" }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Filters{(moduleFilter || actionFilter || search || dateRange !== "all") ? " •" : ""}
          </span>
          <span style={{ fontSize: 14, color: "#64748b", transition: "transform 0.2s", transform: showFilters ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
        </div>

        {showFilters && (
          <div style={{ ...fadeIn, paddingTop: 8, paddingBottom: 4 }}>
            {/* Module + Action dropdowns */}
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <select
                style={{ ...S.inp, flex: 1, fontSize: 13, padding: "8px 10px", minHeight: 36, appearance: "auto" }}
                value={moduleFilter}
                onChange={e => setModuleFilter(e.target.value)}
              >
                {MODULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                style={{ ...S.inp, flex: 1, fontSize: 13, padding: "8px 10px", minHeight: 36, appearance: "auto" }}
                value={actionFilter}
                onChange={e => setActionFilter(e.target.value)}
              >
                {actionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* Date range toggles */}
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {[
                { value: "today", label: "Today" },
                { value: "7d", label: "7 Days" },
                { value: "30d", label: "30 Days" },
                { value: "all", label: "All Time" },
              ].map(d => (
                <button
                  key={d.value}
                  onClick={() => setDateRange(d.value)}
                  style={{
                    flex: 1, padding: "6px 4px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                    fontFamily: "inherit", cursor: "pointer", touchAction: "manipulation", border: "none",
                    background: dateRange === d.value ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.06)",
                    color: dateRange === d.value ? "#60a5fa" : "#94a3b8",
                  }}
                >{d.label}</button>
              ))}
            </div>

            {/* Search */}
            <input
              style={{ ...S.inp, fontSize: 13, padding: "8px 12px", minHeight: 36 }}
              placeholder="Search documents, records, SKUs…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* ENTRIES */}
      <div style={{ padding: "8px 16px 80px" }}>
        {/* Count */}
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, textAlign: "right" }}>
          Showing {Math.min(loaded, total)} of {total} entries
        </div>

        {entries.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: "#475569" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No activity yet</div>
            <div style={{ fontSize: 12 }}>Actions across all modules will appear here.</div>
          </div>
        )}

        {entries.map(entry => {
          const isError = entry.status === "error";
          const expanded = expandedId === entry.id;
          const accentColor = isError ? "#ef4444" : "#22c55e";

          return (
            <div
              key={entry.id}
              onClick={() => setExpandedId(expanded ? null : entry.id)}
              style={{
                ...S.card,
                padding: 0, marginBottom: 8, overflow: "hidden", cursor: "pointer",
                touchAction: "manipulation",
                background: isError ? "rgba(239,68,68,0.04)" : S.card.background,
                borderColor: isError ? "rgba(239,68,68,0.2)" : S.card.borderColor,
                display: "flex",
              }}
            >
              {/* Accent bar */}
              <div style={{ width: 4, flexShrink: 0, background: accentColor, borderRadius: "10px 0 0 10px" }} />

              <div style={{ flex: 1, padding: "12px 14px" }}>
                {/* Top row: timestamp + action */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>
                    {ACTION_LABELS[entry.action] || entry.action}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", ...mono, flexShrink: 0, marginLeft: 8 }}>
                    {formatTimestamp(entry.timestamp)}
                  </div>
                </div>

                {/* Source doc + NS record */}
                <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
                  {entry.sourceDocument && (
                    <span style={{ fontSize: 12, color: "#94a3b8", ...mono }}>{entry.sourceDocument}</span>
                  )}
                  {entry.netsuiteRecord && (
                    <span style={{ fontSize: 12, color: "#818cf8", ...mono }}>{entry.netsuiteRecord}</span>
                  )}
                  {isError && !entry.netsuiteRecord && (
                    <span style={{ fontSize: 11, color: "#ef4444", fontWeight: 600 }}>✕ Error</span>
                  )}
                </div>

                {/* Details */}
                {entry.details && (
                  <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.4, whiteSpace: expanded ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {entry.details}
                  </div>
                )}

                {/* EXPANDED */}
                {expanded && (
                  <div style={{ ...fadeIn, marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                    {/* Items */}
                    {entry.items && entry.items.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
                          Items ({entry.items.length})
                        </div>
                        {entry.items.map((item, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.03)", fontSize: 12 }}>
                            <div>
                              <span style={{ ...mono, color: "#e2e8f0", fontWeight: 600 }}>{item.sku}</span>
                              {item.name && <span style={{ color: "#64748b", marginLeft: 8 }}>{item.name}</span>}
                            </div>
                            <span style={{ ...mono, color: "#94a3b8" }}>×{item.qty}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Error message */}
                    {entry.error && (
                      <div style={{
                        padding: "10px 12px", borderRadius: 6,
                        background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                        fontSize: 12, color: "#f87171", lineHeight: 1.4, marginBottom: 10,
                      }}>
                        {entry.error}
                      </div>
                    )}

                    {/* Meta */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: "#475569" }}>
                      {entry.netsuiteRecordId && (
                        <span>NS ID: <span style={{ ...mono, color: "#94a3b8" }}>{entry.netsuiteRecordId}</span></span>
                      )}
                      <span>Module: <span style={{ color: "#94a3b8" }}>{entry.module}</span></span>
                      <span>{new Date(entry.timestamp).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Load More */}
        {hasMore && (
          <button
            style={{ ...S.btnSec, marginTop: 4 }}
            onClick={() => loadEntries(false)}
          >
            Load More ({total - loaded} remaining)
          </button>
        )}

        {/* CLEAR LOG */}
        {entryCount > 0 && (
          <div style={{ marginTop: 40, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            {!showClearConfirm ? (
              <button
                style={{
                  ...S.btnSec, color: "#ef4444", borderColor: "rgba(239,68,68,0.3)",
                  background: "rgba(239,68,68,0.04)",
                }}
                onClick={handleClearStart}
              >
                🗑 Clear All Entries
              </button>
            ) : (
              <div style={{ ...S.card, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.3)", textAlign: "center", padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#ef4444", marginBottom: 8 }}>
                  Delete all {entryCount.toLocaleString()} log entries?
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
                  This cannot be undone.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={S.btnSec} onClick={() => { setShowClearConfirm(false); setClearCountdown(0); }}>Cancel</button>
                  <button
                    style={{
                      ...S.btn, flex: 1, background: clearCountdown > 0 ? "#64748b" : "#ef4444",
                      opacity: clearCountdown > 0 ? 0.5 : 1,
                    }}
                    onClick={handleClearConfirm}
                    disabled={clearCountdown > 0}
                  >
                    {clearCountdown > 0 ? `Wait ${clearCountdown}s…` : "Permanently Delete"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
