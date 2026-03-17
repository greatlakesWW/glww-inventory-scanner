import { S, FONT, mono, Logo } from "./shared";

const modules = [
  { id: "inventory-count", name: "Inventory Count", subtitle: "Count & adjust inventory", accent: "#3b82f6", icon: "▦" },
  { id: "smart-fulfillment", name: "Smart Fulfillment", subtitle: "Wave pick Shopify orders", accent: "#22c55e", icon: "⇢" },
  { id: "transfer-orders", name: "Transfer Orders", subtitle: "Move between locations", accent: "#7c3aed", icon: "⇄" },
  { id: "item-receipts", name: "Item Receipts", subtitle: "Receive purchase orders", accent: "#f59e0b", icon: "↓" },
];

export default function Home({ setModule }) {
  return (
    <div style={S.root}>
      <style>{FONT}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.3 }}>GLWW Warehouse</span>
        </div>
      </div>

      <div style={{ padding: "24px 16px" }}>
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
