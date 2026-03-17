import { S, FONT, mono, Logo } from "../shared";

export default function ItemReceipts({ onBack }) {
  return (
    <div style={S.root}>
      <style>{FONT}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Item Receipts</span>
        </div>
        <button style={S.btnSm} onClick={onBack}>← Home</button>
      </div>
      <div style={{ padding: 16, textAlign: "center", marginTop: 40 }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px", color: "#f59e0b", ...mono }}>↓</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>Item Receipts</div>
        <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>Receive purchase orders</div>
        <div style={{ ...S.card, background: "rgba(245,158,11,0.04)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <div style={{ fontSize: 13, color: "#64748b" }}>Coming soon — this module is under development.</div>
        </div>
      </div>
    </div>
  );
}
