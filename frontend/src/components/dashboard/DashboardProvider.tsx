"use client";

import * as React from "react";

import {
  Transaction,
  StatItem,
  ChannelItem,
  NotificationItem,
} from "./types";
import { INITIAL_CHANNELS, INITIAL_TXN, INITIAL_NOTIFICATIONS } from "./data";

type Tier = "Super Admin" | "Pro Member" | "Enterprise Owner";
type ToastType = "success" | "info" | "alert";
type Toast = { id: string; msg: string; type: ToastType };

type DashboardContextValue = {
  // Appearance (synced to CSS variables)
  accent: string;
  setAccent: (v: string) => void;
  theme: "light" | "dark";
  setTheme: (v: "light" | "dark") => void;
  density: "compact" | "regular";
  setDensity: (v: "compact" | "regular") => void;
  radius: number;
  setRadius: (v: number) => void;

  // Data
  transactions: Transaction[];
  channels: ChannelItem[];
  stats: StatItem[];
  notifications: NotificationItem[];
  markAllNotificationsRead: () => void;
  markNotificationRead: (id: string) => void;
  userTier: Tier;

  // Shared UI state
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  revRange: number;
  setRevRange: (v: number) => void;

  // Modals
  selectedTxn: Transaction | null;
  setSelectedTxn: (t: Transaction | null) => void;
  showAddTxnModal: boolean;
  setShowAddTxnModal: (b: boolean) => void;
  showUpgradeModal: boolean;
  setShowUpgradeModal: (b: boolean) => void;

  // Toasts
  toasts: Toast[];
  pushToast: (msg: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;

  // Actions
  addTransaction: (data: Omit<Transaction, "id" | "date">) => void;
  deleteTransaction: (id: string) => void;
  updateTransactionStatus: (id: string, status: Transaction["status"]) => void;
  upgradeTier: (tier: string) => void;
};

const DashboardContext = React.createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccent] = React.useState("#7b6ef0");
  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  const [density, setDensity] = React.useState<"compact" | "regular">("regular");
  const [radius, setRadius] = React.useState(18);

  const [searchQuery, setSearchQuery] = React.useState("");
  const [revRange, setRevRange] = React.useState(12);

  const [notifications, setNotifications] =
    React.useState<NotificationItem[]>(INITIAL_NOTIFICATIONS);
  const [transactions, setTransactions] =
    React.useState<Transaction[]>(INITIAL_TXN);
  const [channels] = React.useState<ChannelItem[]>(INITIAL_CHANNELS);
  const [userTier, setUserTier] = React.useState<Tier>("Super Admin");

  const [selectedTxn, setSelectedTxn] = React.useState<Transaction | null>(null);
  const [showAddTxnModal, setShowAddTxnModal] = React.useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = React.useState(false);

  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const pushToast = React.useCallback(
    (msg: string, type: ToastType = "success") => {
      const id = Math.random().toString(36).slice(2, 7);
      setToasts((prev) => [...prev, { id, msg, type }]);
      setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== id)),
        4000,
      );
    },
    [],
  );

  const dismissToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Keep CSS variables in sync with the appearance settings.
  React.useEffect(() => {
    const doc = document.documentElement;
    doc.style.setProperty("--accent", accent);
    doc.style.setProperty("--radius", `${radius}px`);
    doc.dataset.theme = theme;
    doc.dataset.density = density;
  }, [accent, theme, density, radius]);

  // Stat cards recomputed from the live transaction list.
  const stats = ((): StatItem[] => {
    let baseRevenue = 278000;
    transactions.forEach((t) => {
      const amt = parseFloat(t.amt.replace(/[^0-9.]/g, "")) || 0;
      if (t.status === "paid") baseRevenue += amt;
      else if (t.status === "refund") baseRevenue -= amt;
    });
    const baseOrders = 2940;
    const paidPending = transactions.filter(
      (t) => t.status === "paid" || t.status === "pending",
    ).length;
    const baseUsers = 18450;
    const added = transactions.length;

    return [
      {
        key: "rev",
        label: "Total Revenue",
        value: `$${baseRevenue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        delta: 12.8,
        up: true,
        since: "vs last period",
        ico: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
        tint: "var(--accent)",
        spark: [20, 24, 28, 32, 28, 36, 42, 54, 48, 62, 58, 72 + added],
      },
      {
        key: "usr",
        label: "Active Users",
        value: (baseUsers + added).toLocaleString("en-US"),
        delta: 8.3,
        up: true,
        since: "vs last period",
        ico: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1A4 4 0 0 1 16 11",
        tint: "#5b8def",
        spark: [40, 42, 38, 46, 50, 48, 56, 54, 62, 60, 68, 72 + added],
      },
      {
        key: "ord",
        label: "New Orders",
        value: (baseOrders + paidPending).toLocaleString("en-US"),
        delta: 4.1,
        up: true,
        since: "vs last period",
        ico: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0",
        tint: "#2bb39a",
        spark: [58, 54, 60, 50, 56, 52, 48, 54, 50, 58, 55, 62 + paidPending],
      },
      {
        key: "ref",
        label: "Refund Rate",
        value: "1.9%",
        delta: -0.4,
        up: false,
        since: "lower is better",
        ico: "M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9M3 12H1m2 0 3-3M3 12l3 3",
        tint: "#e9a23b",
        spark: [60, 58, 55, 52, 50, 46, 44, 42, 40, 38, 35, 33],
      },
    ];
  })();

  const addTransaction = (data: Omit<Transaction, "id" | "date">) => {
    const id = `TXN-0${transactions.length + 1}`;
    const date = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    setTransactions((prev) => [{ ...data, id, date }, ...prev]);
    setShowAddTxnModal(false);
    pushToast(`Processed transaction for ${data.name} (${data.amt}).`, "success");
    setNotifications((prev) => [
      {
        id: Math.random().toString(),
        title: `${data.name} processed a payment of ${data.amt}.`,
        time: "Just now",
        read: false,
        type: "success",
      },
      ...prev,
    ]);
  };

  const deleteTransaction = (id: string) => {
    if (confirm(`Delete transaction ${id}?`)) {
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      setSelectedTxn((prev) => (prev?.id === id ? null : prev));
      pushToast(`Deleted transaction ${id}.`, "alert");
    }
  };

  const updateTransactionStatus = (
    id: string,
    status: Transaction["status"],
  ) => {
    setTransactions((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status } : t)),
    );
    setSelectedTxn((prev) => (prev?.id === id ? { ...prev, status } : prev));
    pushToast(`Transaction ${id} status updated to ${status}.`, "info");
  };

  const upgradeTier = (tier: string) => {
    setUserTier(tier as Tier);
    setShowUpgradeModal(false);
    pushToast(`Upgraded to ${tier}. Features unlocked.`, "success");
  };

  const markAllNotificationsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    pushToast("All notifications marked as read.", "info");
  };

  const markNotificationRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  };

  const value: DashboardContextValue = {
    accent,
    setAccent,
    theme,
    setTheme,
    density,
    setDensity,
    radius,
    setRadius,
    transactions,
    channels,
    stats,
    notifications,
    markAllNotificationsRead,
    markNotificationRead,
    userTier,
    searchQuery,
    setSearchQuery,
    revRange,
    setRevRange,
    selectedTxn,
    setSelectedTxn,
    showAddTxnModal,
    setShowAddTxnModal,
    showUpgradeModal,
    setShowUpgradeModal,
    toasts,
    pushToast,
    dismissToast,
    addTransaction,
    deleteTransaction,
    updateTransactionStatus,
    upgradeTier,
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = React.useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within a DashboardProvider");
  }
  return ctx;
}
