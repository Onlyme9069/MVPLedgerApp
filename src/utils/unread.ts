import { useSyncExternalStore } from 'react';

// Tiny shared store for the unread chat count (written by NotificationManager, read by the menu / chat UI)
let chatUnread = 0;
const listeners = new Set<() => void>();

export function setChatUnread(n: number) {
  if (n === chatUnread) return;
  chatUnread = n;
  listeners.forEach(l => l());
  // Show the count on the installed app icon where supported (Android / desktop / iOS PWA)
  try {
    const nav = navigator as any;
    if (n > 0) nav.setAppBadge?.(n)?.catch?.(() => {});
    else nav.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* unsupported */ }
}

export function useChatUnread(): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => chatUnread,
    () => 0
  );
}

export const groupSeenKey = (userId: string) => `lastViewedGroupChat_${userId}`;
