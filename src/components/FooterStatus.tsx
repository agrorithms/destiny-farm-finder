'use client';

import { useLiveStats } from '@/hooks/useLiveStats';

function formatFreshness(secondsSinceHeartbeat?: number | null): string {
  if (secondsSinceHeartbeat == null || Number.isNaN(secondsSinceHeartbeat)) {
    return 'Status unavailable';
  }

  if (secondsSinceHeartbeat < 60) {
    return `Updated ${Math.max(0, Math.floor(secondsSinceHeartbeat))}s ago`;
  }

  const minutes = Math.floor(secondsSinceHeartbeat / 60);
  if (minutes < 60) {
    return `Updated ${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

export default function FooterStatus() {
  const { stats } = useLiveStats();

  const label = stats
    ? formatFreshness(stats.secondsSinceHeartbeat)
    : 'Checking status...';

  return <span className="footer-status">{label}</span>;
}
