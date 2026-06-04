"use client";

import OverviewTab from "@/components/dashboard/tabs/OverviewTab";
import { useDashboard } from "@/hooks/useDashboard";

export default function OverviewPage() {
  const d = useDashboard();
  return (
    <OverviewTab
      stats={d.stats}
      channels={d.channels}
      transactions={d.transactions}
      revRange={d.revRange}
      setRevRange={d.setRevRange}
      searchQuery={d.searchQuery}
      setSearchQuery={d.setSearchQuery}
      onSelectTransaction={d.setSelectedTxn}
      onAddTransactionTrigger={() => d.setShowAddTxnModal(true)}
      onDeleteTransaction={d.deleteTransaction}
      onUpdateStatus={d.updateTransactionStatus}
    />
  );
}
