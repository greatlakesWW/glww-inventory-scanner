import { S, FONT, mono, Logo } from "../shared";

export default function SmartFulfillment({ onBack }) {
  return (
    <div style={S.root}>
      <style>{FONT}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Smart Fulfillment</span>
        </div>
        <button style={S.btnSm} onClick={onBack}>← Home</button>
      </div>
      <div style={{ padding: 16, textAlign: "center", marginTop: 40 }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px", color: "#22c55e", ...mono }}>⇢</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>Smart Fulfillment</div>
        <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>Wave pick Shopify orders</div>
        <div style={{ ...S.card, background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.2)" }}>
          <div style={{ fontSize: 13, color: "#64748b" }}>Coming soon — this module is under development.</div>
        </div>
      </div>
    </div>
  );
}
