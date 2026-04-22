import { useState } from "react";
import LocationPicker from "./LocationPicker";
import TOListScreen from "./TOListScreen";
import PickScreen from "./PickScreen";

// ═══════════════════════════════════════════════════════════
// PickTransferOrders — Pick Mode module root
//
// Owns the phase state for the picker flow:
//   "location" → LocationPicker
//   "list"     → TOListScreen for selected location
//   "pick"     → PickScreen (scan loop, spec §5)
//
// No localStorage persistence at this level — users re-pick a
// location if they navigate away. Once a pick session is created
// (Session 4), Vercel KV owns persistence.
//
// Props:
//   onBack() — from App.jsx, returns to Home
// ═══════════════════════════════════════════════════════════
export default function PickTransferOrders({ onBack }) {
  const [phase, setPhase] = useState("location");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedTo, setSelectedTo] = useState(null);

  if (phase === "location") {
    return (
      <LocationPicker
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
      <TOListScreen
        location={selectedLocation}
        onSelect={(to) => {
          setSelectedTo(to);
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
      <PickScreen
        to={selectedTo}
        onBack={() => {
          setSelectedTo(null);
          setPhase("list");
        }}
      />
    );
  }

  // Should be unreachable; defensive fallback.
  return (
    <LocationPicker
      onSelect={(loc) => { setSelectedLocation(loc); setPhase("list"); }}
      onBack={onBack}
    />
  );
}
