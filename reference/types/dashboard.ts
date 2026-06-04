export interface Transaction {
  id: string;
  name: string;
  email: string;
  date: string;
  method: string;
  status: 'paid' | 'pending' | 'failed' | 'refund';
  amt: string; // Keep as string format but we can parse for analysis
  av: string; // color code or avatar text
}

export interface StatItem {
  key: string;
  label: string;
  value: string;
  delta: number;
  up: boolean;
  since: string;
  ico: string;
  tint: string;
  spark: number[];
}

export interface ChannelItem {
  name: string;
  v: number; // percentage
  n: string; // absolute volume
  c: string; // color
}

export interface RevenueData {
  labels: string[];
  cur: number[];
  prev: number[];
}

export interface ActivityData {
  labels: string[];
  vals: number[];
}

export interface NotificationItem {
  id: string;
  title: string;
  time: string;
  read: boolean;
  type: 'info' | 'success' | 'alert' | 'user';
}
