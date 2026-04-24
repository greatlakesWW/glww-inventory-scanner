import { useState } from "react";
import LocationPickerSO from "./LocationPickerSO";
import SOListScreen from "./SOListScreen";
import WavePickScreen from "./WavePickScreen";

// ═══════════════════════════════════════════════════════════
// PickSalesOrders — SO wave pick module root
//
// Phases:
//   "location" → LocationPickerSO
//   "list"     → SOListScreen (multi-select)
//   "pick"     → WavePickScreen (aggregated pick)
//
// Wave is a set of SOs at a single source location. Backend
// session state lives in Vercel KV under session:wave:{sessionId};
// this component only owns navigation.
// ═══════════════════════════════════════════════════════════
export default function PickSalesOrders({ onBack }) {
  const [phase, setPhase] = useState("location");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [wave, setWave] = useState(null); // { sessionId, pickerName, soIds, locationId, ... }

  if (phase === "location") {
    return (
      <LocationPickerSO
        onSelect={(loc) => {
          setSelectedLocation(loc);
          setPhase("list");
        }}
        onBack={onBack}
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
          setWave(null);
          setSelectedLocation(null);
          setPhase("location");
        }}
        onBack={() => {
          setWave(null);
          setPhase("list");
        }}
      />
    );
  }

  return null;
}
