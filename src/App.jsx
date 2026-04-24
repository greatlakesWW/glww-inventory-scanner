import { useState } from "react";
import Home from "./Home";
import InventoryCount from "./modules/InventoryCount";
import SmartFulfillment from "./modules/SmartFulfillment";
import TransferOrders from "./modules/TransferOrders";
import ItemReceipts from "./modules/ItemReceipts";
import ItemLookup from "./modules/ItemLookup";
import BinTransfer from "./modules/BinTransfer";
import CreateInventory from "./modules/CreateInventory";
import PickTransferOrders from "./pick/PickTransferOrders";
import PickSalesOrders from "./pick-so/PickSalesOrders";
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
  if (module === "create-inventory") return <CreateInventory onBack={onBack} />;
  if (module === "pick-transfer-orders") return <PickTransferOrders onBack={onBack} />;
  if (module === "pick-sales-orders") return <PickSalesOrders onBack={onBack} />;
  if (module === "activity-log") return <ActivityLog onBack={onBack} />;

  return <Home setModule={setModule} />;
}
