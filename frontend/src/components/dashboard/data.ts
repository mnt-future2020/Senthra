import { StatItem, ChannelItem, Transaction, RevenueData, ActivityData, NotificationItem } from './types';

export const INITIAL_STATS: StatItem[] = [
  {
    key: 'rev',
    label: 'Total Revenue',
    value: '$284,540',
    delta: 12.4,
    up: true,
    since: 'vs last period',
    ico: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    tint: 'var(--accent)',
    spark: [20, 28, 24, 32, 30, 40, 38, 52, 48, 60, 58, 72]
  },
  {
    key: 'usr',
    label: 'Active Users',
    value: '18,472',
    delta: 8.1,
    up: true,
    since: 'vs last period',
    ico: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1A4 4 0 0 1 16 11',
    tint: '#5b8def',
    spark: [40, 42, 38, 46, 50, 48, 56, 54, 62, 60, 68, 72]
  },
  {
    key: 'ord',
    label: 'New Orders',
    value: '2,948',
    delta: 3.6,
    up: true,
    since: 'vs last period',
    ico: 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
    tint: '#2bb39a',
    spark: [58, 54, 60, 50, 56, 52, 48, 54, 50, 58, 55, 62]
  },
  {
    key: 'ref',
    label: 'Refund Rate',
    value: '1.9%',
    delta: -0.4,
    up: false,
    since: 'lower is better',
    ico: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9M3 12H1m2 0 3-3M3 12l3 3',
    tint: '#e9a23b',
    spark: [60, 58, 55, 52, 50, 46, 44, 42, 40, 38, 35, 33]
  }
];

export const INITIAL_CHANNELS: ChannelItem[] = [
  { name: 'Direct', v: 42, n: '12,840', c: 'var(--accent)' },
  { name: 'Organic', v: 31, n: '9,420', c: '#5b8def' },
  { name: 'Referral', v: 18, n: '5,510', c: '#2bb39a' },
  { name: 'Social', v: 9, n: '2,702', c: '#e9a23b' }
];

export const INITIAL_TXN: Transaction[] = [
  {
    id: 'TXN-001',
    name: 'Marcus Bell',
    email: 'm.bell@northwind.io',
    date: 'Jun 1, 2026',
    method: 'Visa •• 4021',
    status: 'paid',
    amt: '$1,290.00',
    av: '#5b8def'
  },
  {
    id: 'TXN-002',
    name: 'Lena Ortiz',
    email: 'lena@brightpath.co',
    date: 'May 31, 2026',
    method: 'Mastercard •• 8810',
    status: 'pending',
    amt: '$540.00',
    av: '#7b6ef0'
  },
  {
    id: 'TXN-003',
    name: 'Kai Tanaka',
    email: 'kai.t@studioloop.com',
    date: 'May 31, 2026',
    method: 'PayPal',
    status: 'paid',
    amt: '$2,180.00',
    av: '#2bb39a'
  },
  {
    id: 'TXN-004',
    name: 'Priya Nair',
    email: 'priya@meridian.app',
    date: 'May 30, 2026',
    method: 'Visa •• 1199',
    status: 'refund',
    amt: '$320.00',
    av: '#e9a23b'
  },
  {
    id: 'TXN-005',
    name: 'Diego Fuentes',
    email: 'd.fuentes@kova.dev',
    date: 'May 30, 2026',
    method: 'Amex •• 3007',
    status: 'paid',
    amt: '$960.00',
    av: '#ef6f5e'
  },
  {
    id: 'TXN-006',
    name: 'Hannah West',
    email: 'hannah@lumen.studio',
    date: 'May 29, 2026',
    method: 'Mastercard •• 5521',
    status: 'failed',
    amt: '$1,475.00',
    av: '#5bb1c9'
  }
];

export const REVENUE_DATA: Record<number, RevenueData> = {
  12: {
    labels: ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    cur: [182, 168, 201, 224, 210, 248, 236, 272, 258, 295, 281, 318],
    prev: [150, 158, 162, 176, 170, 188, 180, 198, 205, 214, 222, 236]
  },
  6: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    cur: [236, 272, 258, 295, 281, 318],
    prev: [180, 198, 205, 214, 222, 236]
  },
  3: {
    labels: ['Apr', 'May', 'Jun'],
    cur: [295, 281, 318],
    prev: [214, 222, 236]
  }
};

export const ACTIVITY_DATA: ActivityData = {
  labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  vals: [320, 410, 380, 520, 470, 290, 240]
};

export const INITIAL_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'notif-1',
    title: 'High revenue spike detected from Direct channel',
    time: '10 mins ago',
    read: false,
    type: 'success'
  },
  {
    id: 'notif-2',
    title: 'Refund requested for Transaction TXN-004 by Priya Nair',
    time: '2 hours ago',
    read: false,
    type: 'alert'
  },
  {
    id: 'notif-3',
    title: 'Monthly data audit successfully completed',
    time: '1 day ago',
    read: true,
    type: 'info'
  },
  {
    id: 'notif-4',
    title: 'Lena Ortiz signed up for the Premium Enterprise tier',
    time: '2 days ago',
    read: true,
    type: 'user'
  }
];

export const AVAILABLE_ACCENTS = [
  { name: 'Senthra Purple', hex: '#7b6ef0' },
  { name: 'Ocean Pearl', hex: '#5b8def' },
  { name: 'Jade Emerald', hex: '#2bb39a' },
  { name: 'Crimson Ember', hex: '#ef6f5e' },
  { name: 'Solar Amber', hex: '#e9a23b' },
  { name: 'Grey Neutral', hex: '#18181b' }
];

export const DEMO_PRODUCTS = [
  { id: 'PROD-A', name: 'Senthra Core Router v3', category: 'Hardware', price: '$2,499', sales: 142, status: 'In Stock' },
  { id: 'PROD-B', name: 'Cloud SaaS Seat (Annual)', category: 'Software', price: '$120', sales: 1248, status: 'In Stock' },
  { id: 'PROD-C', name: 'Premium Audit Pack Addon', category: 'Compliance', price: '$899', sales: 88, status: 'Limited' },
  { id: 'PROD-D', name: 'Edge Node Sensor Kit', category: 'Hardware', price: '$450', sales: 219, status: 'Out of Stock' },
  { id: 'PROD-E', name: 'Advanced Orchestrator Module', category: 'Software', price: '$1,500', sales: 64, status: 'In Stock' }
];

export const DEMO_CUSTOMERS = [
  { id: 'CUST-301', name: 'Ava Donovan', email: 'ava.donovan@senthra.io', level: 'Administrator', spend: '$12,490', orders: 24, lastActive: 'Active Now', avatarBg: '#7b6ef0' },
  { id: 'CUST-302', name: 'Marcus Bell', email: 'm.bell@northwind.io', level: 'Enterprise', spend: '$8,400', orders: 12, lastActive: '10m ago', avatarBg: '#5b8def' },
  { id: 'CUST-303', name: 'Lena Ortiz', email: 'lena@brightpath.co', level: 'Starter', spend: '$1,540', orders: 3, lastActive: '2h ago', avatarBg: '#7b6ef0' },
  { id: 'CUST-304', name: 'Kai Tanaka', email: 'kai.t@studioloop.com', level: 'Enterprise Plus', spend: '$24,500', orders: 41, lastActive: '34m ago', avatarBg: '#2bb39a' },
  { id: 'CUST-305', name: 'Priya Nair', email: 'priya@meridian.app', level: 'Pro Builder', spend: '$4,120', orders: 9, lastActive: '1d ago', avatarBg: '#e9a23b' },
  { id: 'CUST-306', name: 'Diego Fuentes', email: 'd.fuentes@kova.dev', level: 'Pro Builder', spend: '$5,820', orders: 11, lastActive: '1d ago', avatarBg: '#ef6f5e' }
];
