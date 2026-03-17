import { useState } from "react";
import Home from "./Home";
import InventoryCount from "./modules/InventoryCount";
import SmartFulfillment from "./modules/SmartFulfillment";
import TransferOrders from "./modules/TransferOrders";
import ItemReceipts from "./modules/ItemReceipts";

export default function App() {
  const [module, setModule] = useState(null);

  const onBack = () => setModule(null);

  if (module === "inventory-count") return <InventoryCount onBack={onBack} />;
  if (module === "smart-fulfillment") return <SmartFulfillment onBack={onBack} />;
  if (module === "transfer-orders") return <TransferOrders onBack={onBack} />;
  if (module === "item-receipts") return <ItemReceipts onBack={onBack} />;

  return <Home setModule={setModule} />;
}
