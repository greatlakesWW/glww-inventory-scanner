import { useState, useEffect } from "react";
import { S, FONT, ANIMATIONS, mono, Logo } from "./shared";

const modules = [
  { id: "inventory-count", name: "Inventory Count", subtitle: "Count & adjust inventory", accent: "#3b82f6", icon: "▦" },
  { id: "pick-transfer-orders", name: "Pick Transfer Orders", subtitle: "Outbound TO picking", accent: "#6366f1", icon: "✓" },
  { id: "pick-sales-orders", name: "Pick Sales Orders", subtitle: "Wave pick open SOs", accent: "#22c55e", icon: "🛒" },
  { id: "smart-fulfillment", name: "Smart Fulfillment", subtitle: "Wave pick Shopify orders", accent: "#0ea5e9", icon: "⇢" },
  { id: "transfer-orders", name: "Transfer Orders", subtitle: "Move between locations", accent: "#7c3aed", icon: "⇄" },
  { id: "bin-transfer", name: "Bin Transfer", subtitle: "Move items between bins", accent: "#14b8a6", icon: "⇋" },
  { id: "item-receipts", name: "Item Receipts", subtitle: "Receive purchase orders", accent: "#f59e0b", icon: "↓" },
  { id: "create-inventory", name: "Create Inventory", subtitle: "Add items to bins", accent: "#10b981", icon: "＋" },
];

const ConnDot = ({ status }) => {
  const colors = { checking: "#64748b", connected: "#22c55e", disconnected: "#ef4444" };
  const labels = { checking: "Checking…", connected: "Connected", disconnected: "Offline" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%", background: colors[status],
        boxShadow: status === "connected" ? "0 0 6px rgba(34,197,94,0.5)" : "none",
        transition: "all 0.3s",
      }} />
      <span style={{ fontSize: 10, color: colors[status], ...mono, letterSpacing: 0.3 }}>{labels[status]}</span>
    </div>
  );
};

export default function Home({ setModule }) {
  const [connStatus, setConnStatus] = useState("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/suiteql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "SELECT 1 AS test", limit: 1 }),
        });
        if (!cancelled) setConnStatus(resp.ok ? "connected" : "disconnected");
      } catch {
        if (!cancelled) setConnStatus("disconnected");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.3 }}>GLWW Warehouse</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setModule("activity-log")}
            style={{
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "#94a3b8",
              cursor: "pointer", fontFamily: "inherit", touchAction: "manipulation",
              display: "flex", alignItems: "center", gap: 4,
            }}
          >📋 Log</button>
          <ConnDot status={connStatus} />
        </div>
      </div>

      <div style={{ padding: "24px 16px" }}>
        {/* Item Lookup — utility bar */}
        <button
          onClick={() => setModule("item-lookup")}
          style={{
            display: "flex", alignItems: "center", gap: 12, width: "100%",
            padding: "14px 16px", marginBottom: 16,
            background: "rgba(59,130,246,0.04)",
            border: "1px solid rgba(59,130,246,0.25)",
            borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
            textAlign: "left", transition: "all 0.15s",
            touchAction: "manipulation", minHeight: 56,
          }}
        >
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, color: "#3b82f6", flexShrink: 0,
          }}>🔍</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>Item Lookup</div>
            <div style={{ fontSize: 11, color: "#64748b" }}>Scan any item to check inventory</div>
          </div>
          <div style={{ marginLeft: "auto", color: "#475569", fontSize: 18 }}>›</div>
        </button>

        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}>
          {modules.map(m => (
            <button
              key={m.id}
              onClick={() => setModule(m.id)}
              style={{
                ...S.card,
                padding: 0,
                marginBottom: 0,
                cursor: "pointer",
                border: `1px solid ${m.accent}33`,
                background: `${m.accent}08`,
                textAlign: "left",
                transition: "all 0.15s",
                overflow: "hidden",
                minHeight: 140,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Icon area */}
              <div style={{
                padding: "18px 16px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: `${m.accent}18`,
                  border: `1px solid ${m.accent}30`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 24,
                  color: m.accent,
                  ...mono,
                  fontWeight: 700,
                }}>{m.icon}</div>
              </div>

              {/* Text */}
              <div style={{ padding: "4px 14px 16px", flex: 1 }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#e2e8f0",
                  marginBottom: 4,
                  lineHeight: 1.3,
                }}>{m.name}</div>
                <div style={{
                  fontSize: 11,
                  color: "#94a3b8",
                  lineHeight: 1.4,
                }}>{m.subtitle}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "14px 16px",
        textAlign: "center",
        background: "linear-gradient(transparent, #0a0e17 40%)",
      }}>
        <div style={{ fontSize: 11, color: "#475569", ...mono, marginBottom: 2 }}>v4.0</div>
        <div style={{ fontSize: 10, color: "#334155", letterSpacing: 0.5, textTransform: "uppercase" }}>Great Lakes Work Wear</div>
      </div>
    </div>
  );
}
