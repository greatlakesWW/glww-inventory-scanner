import { useState } from "react";
import LocationPickerSO from "./LocationPickerSO";
import SOListScreen from "./SOListScreen";
import WavePickScreen from "./WavePickScreen";
import PlanScreen from "./PlanScreen";

// ═══════════════════════════════════════════════════════════
// PickSalesOrders — SO wave pick module root
//
// Phases:
//   "plan"     → PlanScreen (default — scan Shopify orders, build
//                 multi-location plan)
//   "location" → LocationPickerSO (browse mode — pick by location)
//   "list"     → SOListScreen (single-location SO list)
//   "pick"     → WavePickScreen
// ═══════════════════════════════════════════════════════════
export default function PickSalesOrders({ onBack }) {
  const [phase, setPhase] = useState("plan");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [wave, setWave] = useState(null);
  // When a wave from the plan completes we need to tell the
  // PlanScreen which location it was so the plan can mark that
  // location ✓. Bumping this counter forces PlanScreen's effect to
  // re-fire even if the same locationId completes twice in a row.
  const [planCompletionSignal, setPlanCompletionSignal] = useState({ locationId: null, n: 0 });
  const [waveOriginatedFromPlan, setWaveOriginatedFromPlan] = useState(false);

  // Handlers from the PlanScreen
  const handlePickAtLocation = async ({ locationId, locationName, soIds, pickerName }) => {
    try {
      const r = await fetch("/api/so-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickerName, locationId, soIds }),
      });
      let data = await r.json();
      // H-3: every requested SO has already been fulfilled at this
      // location (a sibling-location wave shipped them while we were
      // away). Mark the location done in the plan and bail.
      if (r.status === 409 && data?.error === "already_fulfilled_at_location") {
        const labels = (data.soIds || []).map((s) => s.tranId || `#${s.soId}`).join(", ");
        alert(`Already fulfilled at ${locationName}.\n\n${labels || "These items"} were shipped from another location. Marking ${locationName} as done.`);
        setPlanCompletionSignal((prev) => ({ locationId: String(locationId), n: prev.n + 1 }));
        return;
      }
      // Lock conflict — offer override for any wave that has no scans.
      if (r.status === 409 && data?.error === "locked" && Array.isArray(data.conflicts)) {
        const stuck = data.conflicts.filter((c) => c.hasScans);
        if (stuck.length > 0) {
          alert("Some SOs are actively being picked elsewhere: " +
            stuck.map((c) => `SO${c.soId} by ${c.lockedBy}`).join("; "));
          return;
        }
        const ok = confirm(
          `Some of these SOs are held by another picker but haven't been scanned yet (${data.conflicts.map((c) => c.lockedBy).join(", ")}). Override and take over?`
        );
        if (!ok) return;
        const r2 = await fetch("/api/so-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pickerName, locationId, soIds, force: true }),
        });
        data = await r2.json();
        if (!r2.ok) {
          alert("Override failed: " + (data?.error || `API ${r2.status}`));
          return;
        }
      } else if (!r.ok) {
        alert("Couldn't start wave: " + (data?.error || `API ${r.status}`));
        return;
      }
      // H-3 partial case: some — but not all — requested SOs at this
      // location were already fulfilled. The wave starts with the rest.
      if (Array.isArray(data?.droppedSoIds) && data.droppedSoIds.length > 0) {
        alert(`Heads up — ${data.droppedSoIds.length} SO${data.droppedSoIds.length === 1 ? "" : "s"} at ${locationName} were already fulfilled from another location. Continuing with the rest.`);
      }
      setSelectedLocation({ id: locationId, name: locationName });
      setWave(data);
      setWaveOriginatedFromPlan(true);
      setPhase("pick");
    } catch (e) {
      alert("Couldn't start wave: " + e.message);
    }
  };

  const handleBrowseByLocation = () => {
    setPhase("location");
  };

  if (phase === "plan") {
    return (
      <PlanScreen
        onPickAtLocation={handlePickAtLocation}
        onBrowseByLocation={handleBrowseByLocation}
        onBack={onBack}
        completionSignal={planCompletionSignal}
      />
    );
  }

  if (phase === "location") {
    return (
      <LocationPickerSO
        onSelect={(loc) => {
          setSelectedLocation(loc);
          setWaveOriginatedFromPlan(false);
          setPhase("list");
        }}
        onBack={() => setPhase("plan")}
      />
    );
  }

  if (phase === "list") {
    return (
      <SOListScreen
        location={selectedLocation}
        onStartPick={(session) => {
          setWave(session);
          setPhase("pick");
        }}
        onBack={() => {
          setSelectedLocation(null);
          setPhase("location");
        }}
      />
    );
  }

  if (phase === "pick") {
    return (
      <WavePickScreen
        wave={wave}
        location={selectedLocation}
        onComplete={() => {
          if (waveOriginatedFromPlan && selectedLocation?.id) {
            // Mark this location done in the plan and bounce back.
            setPlanCompletionSignal((prev) => ({ locationId: String(selectedLocation.id), n: prev.n + 1 }));
            setWave(null);
            setSelectedLocation(null);
            setWaveOriginatedFromPlan(false);
            setPhase("plan");
          } else {
            // Browse-mode: same as before.
            setWave(null);
            setSelectedLocation(null);
            setPhase("location");
          }
        }}
        onBack={() => {
          setWave(null);
          if (waveOriginatedFromPlan) {
            setSelectedLocation(null);
            setWaveOriginatedFromPlan(false);
            setPhase("plan");
          } else {
            setPhase("list");
          }
        }}
      />
    );
  }

  return null;
}
