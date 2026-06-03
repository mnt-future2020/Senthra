"use client";

import InvoicesTab from "@/components/dashboard/tabs/InvoicesTab";
import { useDashboard } from "@/hooks/useDashboard";

export default function InvoicesPage() {
  const d = useDashboard();
  return (
    <InvoicesTab
      transactions={d.transactions}
      onSelectTransaction={d.setSelectedTxn}
      onDeleteTransaction={d.deleteTransaction}
      onUpdateStatus={d.updateTransactionStatus}
    />
  );
}
