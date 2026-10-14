import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Bell, X, Sparkles } from 'lucide-react';
import { dbService } from '../services/dbService';
import { notificationService } from '../services/notificationService';
import { User } from '../types';
import { setChatUnread, groupSeenKey } from '../utils/unread';

interface Toast {
  id: string;
  title: string;
  body: string;
  type: 'message' | 'dispute' | 'payment' | 'system';
  payload?: any;
}

interface NotificationManagerProps {
  currentUser: User;
}

export default function NotificationManager({ currentUser }: NotificationManagerProps) {
  const [showPromptBanner, setShowPromptBanner] = useState(false);

  // Timestamps to filter older messages and notices
  const loginTimeRef = useRef<string>(new Date().toISOString());
  const processedIdsRef = useRef<Set<string>>(new Set());

  // iOS only supports web push for apps added to the Home Screen
  const [showIosHint, setShowIosHint] = useState(false);

  // Update permission state
  useEffect(() => {
    if (notificationService.isIOS() && !notificationService.isStandalone()) {
      let dismissed = false;
      try { dismissed = localStorage.getItem('mvp_ios_install_hint') === '1'; } catch { /* ignore */ }
      if (!dismissed) {
        const timer = setTimeout(() => setShowIosHint(true), 3000);
        return () => clearTimeout(timer);
      }
      return;
    }
    if (notificationService.isSupported()) {
      const current = notificationService.getPermissionState();
      if (current === 'default') {
        // Show a gentle prompt banner in the app to ask for push permission
        const timer = setTimeout(() => setShowPromptBanner(true), 3000);
        return () => clearTimeout(timer);
      }
      if (current === 'granted') void notificationService.ensurePushSubscription();
    }
  }, [currentUser.userId]);

  // Deep links: tapping a push notification (cold start via ?open=..., or a message from the service worker)
  useEffect(() => {
    const go = (target: string | null, chatId: string | null) => {
      if (target === 'chat') window.dispatchEvent(new CustomEvent('app:open-chat', { detail: { receiverId: chatId || undefined } }));
      else if (target === 'notices') window.dispatchEvent(new CustomEvent('app:open-notices'));
    };
    const params = new URLSearchParams(window.location.search);
    if (params.get('open')) {
      const t = window.setTimeout(() => go(params.get('open'), params.get('with')), 600);
      window.history.replaceState({}, '', window.location.pathname);
      var cleanup = () => window.clearTimeout(t);
    }
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === 'open') go(e.data.open, e.data.with || null);
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => { navigator.serviceWorker?.removeEventListener('message', onSwMessage); cleanup?.(); };
  }, []);

  // Request browser push permission
  const handleRequestPermission = async () => {
    const result = await notificationService.requestPermission();
    setShowPromptBanner(false);
    
    if (result === 'granted') {
      void notificationService.ensurePushSubscription();
      notificationService.sendNotification(
        'Push Notifications Active',
        'You will now receive real-time alerts for chats and ledger disputes!'
      );
    }
  };

  // Poll for new messages and new disputes (notices) every 5 seconds
  useEffect(() => {
    if (!currentUser) return;

    let cancelled = false;

    // Unread chat count: unread DMs + group messages newer than the last time the group chat was opened
    const updateChatUnread = (messages: any[]) => {
      let groupSeen = '';
      try {
        groupSeen = localStorage.getItem(groupSeenKey(currentUser.userId)) || '';
        if (!groupSeen) { groupSeen = new Date().toISOString(); localStorage.setItem(groupSeenKey(currentUser.userId), groupSeen); }
      } catch { /* ignore */ }
      const n = messages.filter(m =>
        !m.isDeleted && m.senderId !== currentUser.userId &&
        ((m.receiverId === currentUser.userId && !m.isRead) || (m.receiverId === 'all' && m.createdAt > groupSeen))
      ).length;
      setChatUnread(n);
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    let busy = false;

    // Load initial context once to avoid spamming existing entries
    const initializeTracker = async () => {
      try {
        const [messages, notices] = await Promise.all([
          dbService.getMessages(),
          dbService.getNotices()
        ]);
        
        // Populate processed list with all current items so we don't alert old ones
        if (messages) { messages.forEach(m => processedIdsRef.current.add(m.id)); updateChatUnread(messages); }
        if (notices) notices.forEach(n => processedIdsRef.current.add(n.id));
      } catch (err) {
        console.error('Error initializing notification trackers', err);
      }
    };

    const checkNewEvents = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const [messages, notices] = await Promise.all([
          dbService.getMessages(),
          dbService.getNotices()
        ]);

        if (messages) updateChatUnread(messages);

        // 1. Check for new messages
        if (messages) {
          messages.forEach(msg => {
            // Must not be from current user, must be either group chat or addressed directly to current user, and not yet processed
            const isTarget = msg.receiverId === 'all' || msg.receiverId === currentUser.userId;
            const isNotMe = msg.senderId !== currentUser.userId;
            
            if (isNotMe && isTarget && !processedIdsRef.current.has(msg.id)) {
              processedIdsRef.current.add(msg.id);
              // Everything that existed at startup is already in processedIds, so anything new is alerted immediately
              if (!msg.isDeleted) {
                triggerAlert({
                  id: msg.id,
                  title: `${msg.senderName || msg.senderId} sent you a message`,
                  body: msg.content.length > 60 ? `${msg.content.substring(0, 60)}...` : msg.content,
                  type: 'message',
                  payload: { chatId: msg.receiverId === 'all' ? 'all' : msg.senderId }
                });
              }
            }
          });
        }

        // 2. Check for new disputes (notices)
        if (notices) {
          notices.forEach(notice => {
            // Must not be reported by current user and not yet processed
            const isNotMe = notice.reportedBy !== currentUser.userId;
            
            if (isNotMe && !processedIdsRef.current.has(notice.id)) {
              processedIdsRef.current.add(notice.id);

              const amt = `₹${notice.recordAmount.toLocaleString('en-IN')}`;
              if (notice.kind === 'payment') {
                const party = notice.paymentParty || notice.reason.replace(/^(Paid to|Received from)\s+/i, '');
                triggerAlert({
                  id: notice.id,
                  title: notice.paymentDirection === 'received'
                    ? `Mission Vikram Prakalp received payment of ${amt} from ${party}`
                    : `Mission Vikram Prakalp made payment of ${amt} to ${party}`,
                  body: notice.recordPurpose,
                  type: 'payment',
                  payload: notice
                });
              } else {
                triggerAlert({
                  id: notice.id,
                  title: `${notice.reporterName || notice.reportedBy} raised dispute of ${amt}`,
                  body: `"${notice.recordPurpose}" · ${notice.reason}`,
                  type: 'dispute',
                  payload: notice
                });
              }
            }
          });
        }
      } catch (err) {
        console.warn('Error checking real-time events', err);
      } finally {
        busy = false;
      }
    };

    // Start polling only after the baseline is loaded; poll fast (1.5s) and re-check instantly on focus
    const onWake = () => { if (document.visibilityState === 'visible') checkNewEvents(); };
    (async () => {
      await initializeTracker();
      if (cancelled) return;
      interval = setInterval(checkNewEvents, 1500);
      document.addEventListener('visibilitychange', onWake);
      window.addEventListener('focus', onWake);
    })();

    return () => {
      cancelled = true;
      setChatUnread(0);
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [currentUser]);

  // Listener to open correct interface when a custom trigger is received
  useEffect(() => {
    const handleTriggerMessageNotification = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.senderId && customEvent.detail.senderId !== currentUser.userId) {
        // Optional quick local triggers
      }
    };
    
    window.addEventListener('app:new-message-arrived', handleTriggerMessageNotification);
    return () => window.removeEventListener('app:new-message-arrived', handleTriggerMessageNotification);
  }, [currentUser]);

  // Open the right screen when the user taps the toast action
  const openTarget = (t: Toast) => {
    if (t.type === 'message') {
      window.dispatchEvent(new CustomEvent('app:open-chat', { detail: { receiverId: t.payload?.chatId || 'all' } }));
    } else if (t.type === 'dispute' || t.type === 'payment') {
      window.dispatchEvent(new CustomEvent('app:open-notices'));
    }
  };

  // Show a Sonner toast (and a system push notification when the app is in the background)
  const triggerAlert = (t: Toast) => {
    if (document.visibilityState !== 'visible') {
      notificationService.sendNotification(t.title, t.body);
    }

    const options = {
      id: t.id,
      description: t.body,
      duration: 6000,
      action: { label: t.type === 'message' ? 'Open' : 'View', onClick: () => openTarget(t) },
    };

    if (t.type === 'payment') toast.success(t.title, options);
    else if (t.type === 'dispute') toast.warning(t.title, options);
    else if (t.type === 'message') toast.info(t.title, options);
    else toast(t.title, options);
  };

  return (
    <>
      <AnimatePresence>
        {showIosHint && (
          <motion.div
            initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-4 left-4 right-4 z-50 bg-gray-900 text-white p-4 rounded-2xl shadow-2xl border border-gray-800"
            style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex gap-3 items-start">
              <div className="bg-amber-500/10 p-2.5 rounded-xl shrink-0 text-amber-400"><Bell className="h-5 w-5" /></div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-black text-gray-100">Get notifications on iPhone</h4>
                <p className="text-[11px] text-gray-400 font-semibold mt-1 leading-relaxed">
                  Tap the Share button in Safari, choose <b className="text-gray-200">Add to Home Screen</b>, then open the app from your Home Screen and allow notifications.
                </p>
              </div>
              <button
                onClick={() => { setShowIosHint(false); try { localStorage.setItem('mvp_ios_install_hint', '1'); } catch { /* ignore */ } }}
                className="text-gray-400 hover:text-gray-200 p-0.5 rounded cursor-pointer"
              ><X className="h-4 w-4" /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent Bottom banner prompt if permissions are not configured */}
      <AnimatePresence>
        {showPromptBanner && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-4 left-4 right-4 md:left-auto md:w-96 z-50 bg-gray-900 text-white p-4 rounded-2xl shadow-2xl border border-gray-800 animate-in fade-in duration-300"
          >
            <div className="flex gap-3 items-start">
              <div className="bg-amber-500/10 p-2.5 rounded-xl shrink-0 text-amber-400">
                <Bell className="h-5 w-5 animate-bounce" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-black tracking-tight flex items-center gap-1.5 text-gray-100">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  Stay Updated with Real-time Alerts
                </h4>
                <p className="text-[10px] text-gray-400 font-bold mt-1 leading-relaxed">
                  Enable push notifications to receive real-time updates on active ledger disputes and peer direct chat messages.
                </p>
                <div className="flex gap-2.5 mt-3">
                  <button
                    onClick={handleRequestPermission}
                    className="bg-amber-500 hover:bg-amber-600 text-gray-950 px-3.5 py-1.5 rounded-lg text-[10px] font-black uppercase transition-colors cursor-pointer"
                  >
                    Enable Push
                  </button>
                  <button
                    onClick={() => setShowPromptBanner(false)}
                    className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                  >
                    Not Now
                  </button>
                </div>
              </div>
              <button
                onClick={() => setShowPromptBanner(false)}
                className="text-gray-400 hover:text-gray-200 p-0.5 rounded transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
