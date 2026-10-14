function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function sessionToken(): string {
  try { return JSON.parse(localStorage.getItem('mvp_finance_session') || '{}').sessionToken || ''; } catch { return ''; }
}
const authJson = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken()}` });

export const notificationService = {
  /** True when running as an installed app (home-screen / standalone). */
  isStandalone(): boolean {
    return typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  },

  isIOS(): boolean {
    return typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  },

  isPushSupported(): boolean {
    return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  /** Subscribe this device to server push (works with the app closed). Safe to call repeatedly. */
  async ensurePushSubscription(): Promise<boolean> {
    try {
      if (!this.isPushSupported() || Notification.permission !== 'granted' || !sessionToken()) return false;
      const keyRes = await fetch('/api/push/public-key');
      const { publicKey } = await keyRes.json();
      if (!publicKey) return false; // server has no VAPID keys configured
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource });
      }
      const res = await fetch('/api/push/subscribe', { method: 'POST', headers: authJson(), body: JSON.stringify({ subscription: sub.toJSON() }) });
      return res.ok;
    } catch (err) {
      console.warn('Push subscription failed', err);
      return false;
    }
  },

  /** Remove this device from the current user's push list (call before logout). */
  async unsubscribePush(): Promise<void> {
    try {
      if (!this.isPushSupported()) return;
      const headers = authJson(); // capture the token now, before logout clears it
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/push/unsubscribe', { method: 'POST', headers, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    } catch { /* ignore */ }
  },

  isSupported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
  },

  getPermissionState(): NotificationPermission {
    if (!this.isSupported()) return 'denied';
    return Notification.permission;
  },

  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) return 'denied';
    try {
      const permission = await Notification.requestPermission();
      return permission;
    } catch (err) {
      console.warn('Error requesting notification permission', err);
      return 'default';
    }
  },

  async sendNotification(title: string, body: string, icon?: string): Promise<boolean> {
    if (!this.isSupported() || Notification.permission !== 'granted') {
      return false;
    }
    try {
      // 1. Try sending via service worker registration first (most robust, works in background/minimized/mobile)
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        if (registration && 'showNotification' in registration) {
          await registration.showNotification(title, {
            body,
            icon: icon || '/icon-192.png',
            badge: '/icon-192.png',
            tag: 'mvp-ledger-notification',
            renotify: true,
            vibrate: [100, 50, 100],
            data: {
              dateOfArrival: Date.now(),
              primaryKey: 1
            }
          } as any);
          return true;
        }
      }
      
      // 2. Fallback to standard window Notification if service worker is not ready or unsupported
      new Notification(title, {
        body,
        icon: icon || '/icon-192.png'
      });
      return true;
    } catch (err) {
      console.warn('Error sending browser notification', err);
      return false;
    }
  }
};
