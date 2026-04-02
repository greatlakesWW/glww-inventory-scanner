import { useState } from "react";
import Home from "./Home";
import InventoryCount from "./modules/InventoryCount";
import SmartFulfillment from "./modules/SmartFulfillment";
import TransferOrders from "./modules/TransferOrders";
import ItemReceipts from "./modules/ItemReceipts";
import ItemLookup from "./modules/ItemLookup";
import BinTransfer from "./modules/BinTransfer";
import ActivityLog from "./modules/ActivityLog";

export default function App() {
  const [module, setModule] = useState(null);

  const onBack = () => setModule(null);

  if (module === "item-lookup") return <ItemLookup onBack={onBack} />;
  if (module === "inventory-count") return <InventoryCount onBack={onBack} />;
  if (module === "smart-fulfillment") return <SmartFulfillment onBack={onBack} />;
  if (module === "transfer-orders") return <TransferOrders onBack={onBack} />;
  if (module === "bin-transfer") return <BinTransfer onBack={onBack} />;
  if (module === "item-receipts") return <ItemReceipts onBack={onBack} />;
  if (module === "activity-log") return <ActivityLog onBack={onBack} />;

  return <Home setModule={setModule} />;
}
