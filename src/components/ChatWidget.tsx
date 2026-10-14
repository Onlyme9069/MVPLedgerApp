import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, Search, Plus, Heart, ArrowUp, X, Pin, CornerUpLeft, Copy, Pencil, Trash2, Check, Users, MessageCircle, Bell, MoreVertical, Smile } from 'lucide-react';
import { dbService } from '../services/dbService';
import { User as UserType, Message } from '../types';
import { triggerHapticFeedback } from '../utils/haptics';
import { groupSeenKey } from '../utils/unread';

interface ChatWidgetProps {
  currentUser: UserType;
  isOpen?: boolean;
  setIsOpen?: (open: boolean) => void;
}

const EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
const AVATAR_GRADIENTS = [
  'from-neutral-500 to-neutral-700', 'from-stone-500 to-stone-700', 'from-zinc-500 to-zinc-700',
  'from-slate-500 to-slate-700', 'from-neutral-600 to-neutral-800', 'from-stone-600 to-stone-800',
];

// ---------- helpers ----------
const gradientFor = (key: string) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
};
const cleanName = (n: string) => n.replace(/\s*\(.*?\)\s*/g, '').trim() || n;
const initials = (n: string) => cleanName(n).split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('');
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayLabel = (iso: string) => {
  const d = new Date(iso), now = new Date();
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const listTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return timeOf(iso);
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const sameMsg = (a: Message, b: Message) =>
  a.content === b.content && a.isRead === b.isRead && a.isEdited === b.isEdited && a.isPinned === b.isPinned &&
  a.isDeleted === b.isDeleted && JSON.stringify(a.reactions || null) === JSON.stringify(b.reactions || null);

/** Keep object identity for unchanged messages so memoised bubbles don't re-render on every poll. */
function mergeMessages(prev: Message[], next: Message[], pending: Set<string>): Message[] {
  const prevById = new Map(prev.map(m => [m.id, m]));
  const merged = next.map(m => {
    const old = prevById.get(m.id);
    return old && sameMsg(old, m) ? old : m;
  });
  if (pending.size) {
    const have = new Set(merged.map(m => m.id));
    prev.forEach(m => { if (pending.has(m.id) && !have.has(m.id)) merged.push(m); });
  }
  if (merged.length === prev.length && merged.every((m, i) => m === prev[i])) return prev;
  return merged;
}

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const fn = () => setDesktop(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return desktop;
}

// ---------- Avatar ----------
const Avatar = memo(function Avatar({ name, group, size = 48 }: { name: string; group?: boolean; size?: number }) {
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className={`shrink-0 rounded-full bg-gradient-to-b ${group ? 'from-neutral-700 to-neutral-900' : gradientFor(name)} text-white font-semibold flex items-center justify-center select-none`}
    >
      {group ? <Users style={{ width: size * 0.5, height: size * 0.5 }} /> : initials(name)}
    </div>
  );
});

// ---------- Bubble ----------
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200d|\s){1,8}$/u;

interface BubbleProps {
  msg: Message;
  mine: boolean;
  showName: boolean;
  tail: boolean;
  gapTop: boolean;
  flash: boolean;
  receipt?: string;
  onMenu: (m: Message) => void;
  onJump: (id: string) => void;
  onLike: (m: Message) => void;
  onReply: (m: Message) => void;
}
const Bubble = memo(function Bubble({ msg, mine, showName, tail, gapTop, flash, receipt, onMenu, onJump, onLike, onReply }: BubbleProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moved = useRef(false);
  const lastTap = useRef(0);
  const [pop, setPop] = useState(0);

  const start = (e: React.PointerEvent) => {
    if (msg.isDeleted) return;
    moved.current = false;
    timer.current = setTimeout(() => { if (!moved.current) { triggerHapticFeedback('medium'); onMenu(msg); } }, 380);
    (e.currentTarget as HTMLElement).dataset.x = String(e.clientX);
    (e.currentTarget as HTMLElement).dataset.y = String(e.clientY);
  };
  const move = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (Math.abs(e.clientX - Number(el.dataset.x)) > 8 || Math.abs(e.clientY - Number(el.dataset.y)) > 8) {
      moved.current = true;
      if (timer.current) clearTimeout(timer.current);
    }
  };
  const end = () => { if (timer.current) clearTimeout(timer.current); };

  // double-tap = like (works for touch and mouse)
  const tap = () => {
    if (msg.isDeleted || moved.current) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      triggerHapticFeedback('light');
      setPop(p => p + 1);
      onLike(msg);
    } else lastTap.current = now;
  };

  const reactions = msg.reactions ? Object.values(msg.reactions) : [];
  const reactionSummary = reactions.length ? Array.from(new Set(reactions)).join('') + (reactions.length > 1 ? ` ${reactions.length}` : '') : '';
  const bigEmoji = !msg.isDeleted && !msg.replyToId && msg.content.length <= 16 && EMOJI_ONLY.test(msg.content);

  return (
    <div id={`msg-${msg.id}`} className={`flex flex-col ${mine ? 'items-end' : 'items-start'} ${gapTop ? 'mt-2' : 'mt-[2px]'}`}>
      {showName && <span className="text-[10px] text-neutral-500 ml-2.5 mb-0.5">{cleanName(msg.senderName)}</span>}
      <motion.div
        drag={msg.isDeleted ? false : 'x'}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0, right: 0.35 }}
        dragSnapToOrigin
        onDragEnd={(_, info) => { if (info.offset.x > 55) { triggerHapticFeedback('light'); onReply(msg); } }}
        className={`relative max-w-[80%] flex items-center ${reactionSummary ? 'mb-3' : ''}`}
      >
        <div
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
          onClick={tap}
          onContextMenu={e => { e.preventDefault(); if (!msg.isDeleted) onMenu(msg); }}
          style={{ WebkitTouchCallout: 'none' }}
          className={`relative text-[15px] leading-[20px] whitespace-pre-wrap break-words select-none transition-shadow ${
            bigEmoji
              ? 'text-[44px] leading-[50px] px-1'
              : `px-3.5 py-2 rounded-[20px] ${tail ? (mine ? 'rounded-br-[5px]' : 'rounded-bl-[5px]') : ''} ${
                  msg.isDeleted
                    ? 'bg-transparent border border-neutral-300 text-neutral-400 italic'
                    : mine ? 'bg-black text-white' : 'bg-white text-black'
                }`
          } ${flash ? 'ring-4 ring-neutral-400/50' : ''}`}
        >
          {msg.replyToId && !msg.isDeleted && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onJump(msg.replyToId!)}
              className={`block w-full text-left mb-1 pl-2 border-l-2 text-[12px] leading-[16px] ${mine ? 'border-white/50 text-white/80' : 'border-neutral-300 text-neutral-500'}`}
            >
              <span className="font-semibold block truncate">{cleanName(msg.replyToSenderName || '')}</span>
              <span className="block line-clamp-2 opacity-90">{msg.replyToContent}</span>
            </button>
          )}
          {msg.content}
          {pop > 0 && (
            <motion.span
              key={pop}
              initial={{ scale: 0.3, opacity: 1 }} animate={{ scale: 1.6, opacity: 0 }} transition={{ duration: 0.7, ease: 'easeOut' }}
              className="absolute inset-0 flex items-center justify-center text-[34px] pointer-events-none"
            >❤️</motion.span>
          )}
        </div>
        {reactionSummary && (
          <div className={`absolute -bottom-3 ${mine ? '-left-2' : '-right-2'} bg-white border border-neutral-200 shadow-sm rounded-full px-1.5 py-[1px] text-[12px] leading-[16px] text-black`}>
            {reactionSummary}
          </div>
        )}
      </motion.div>
      {(tail && !msg.isDeleted) && (
        <span className={`text-[10px] text-neutral-400 mt-0.5 ${mine ? 'mr-1' : 'ml-1'}`}>
          {timeOf(msg.createdAt)}{msg.isEdited ? ' · Edited' : ''}{receipt ? ` · ${receipt}` : ''}
        </span>
      )}
    </div>
  );
});

// ---------- Main ----------
export default function ChatWidget({ currentUser, isOpen, setIsOpen }: ChatWidgetProps) {
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const open = isOpen !== undefined ? isOpen : localIsOpen;
  const setOpen = setIsOpen !== undefined ? setIsOpen : setLocalIsOpen;
  const desktop = useIsDesktop();

  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<UserType[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // 'all' | userId | null (list on mobile)
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menuMsg, setMenuMsg] = useState<Message | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [fabOpen, setFabOpen] = useState(false);
  const [headMenu, setHeadMenu] = useState(false);
  const [emojiBar, setEmojiBar] = useState(false);

  const pendingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCount = useRef(0);
  const lastSelected = useRef<string | null>(null);

  // data: users + messages (fast polling only while open)
  useEffect(() => {
    if (!open) return;
    let alive = true;
    dbService.getUsers().then(u => { if (alive) setUsers((u || []).filter(x => x.userId !== currentUser.userId && x.status !== 'disabled')); }).catch(() => {});
    const unsub = dbService.subscribeMessages(next => {
      setMessages(prev => mergeMessages(prev, next, pendingRef.current));
    }, 5000);
    return () => { alive = false; unsub(); };
  }, [open, currentUser.userId]);

  // open a specific conversation from a toast / push tap
  useEffect(() => {
    const onOpen = (e: Event) => {
      const r = (e as CustomEvent).detail?.receiverId as string | undefined;
      if (r) setSelected(r === currentUser.userId ? 'all' : r);
    };
    window.addEventListener('app:open-chat', onOpen);
    return () => window.removeEventListener('app:open-chat', onOpen);
  }, [currentUser.userId]);

  // desktop: nothing selected -> show group
  useEffect(() => { if (open && desktop && selected === null) setSelected('all'); }, [open, desktop, selected]);
  useEffect(() => { if (!open) { setMenuMsg(null); setReplyingTo(null); setEditing(null); setFabOpen(false); setHeadMenu(false); setEmojiBar(false); setFilter('all'); } }, [open]);

  // conversation messages
  const thread = useMemo(() => {
    if (!selected) return [];
    return messages.filter(m => selected === 'all'
      ? m.receiverId === 'all'
      : (m.senderId === currentUser.userId && m.receiverId === selected) || (m.senderId === selected && m.receiverId === currentUser.userId));
  }, [messages, selected, currentUser.userId]);

  // mark as read (DM) / mark group as seen
  useEffect(() => {
    if (!open || !selected) return;
    if (selected === 'all') {
      try { localStorage.setItem(groupSeenKey(currentUser.userId), new Date().toISOString()); } catch { /* ignore */ }
      return;
    }
    messages.filter(m => m.senderId === selected && m.receiverId === currentUser.userId && !m.isRead).forEach(m => {
      dbService.updateMessage(m.id, { isRead: true }).catch(() => {});
    });
  }, [messages, selected, open, currentUser.userId]);

  // typing indicator of the DM partner
  useEffect(() => {
    if (!open || !selected || selected === 'all') { setPartnerTyping(false); return; }
    let alive = true;
    const tick = async () => {
      try {
        const d = await dbService.getTypingState(selected);
        if (alive) setPartnerTyping(!!d?.isTyping && d?.typingTo === currentUser.userId && Date.now() - (d?.updatedAt || 0) < 6000);
      } catch { if (alive) setPartnerTyping(false); }
    };
    void tick();
    const t = window.setInterval(tick, 4000);
    const onLive = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.type === 'typing' && d.userId === selected) void tick(); };
    window.addEventListener('live', onLive);
    return () => { alive = false; window.clearInterval(t); window.removeEventListener('live', onLive); };
  }, [open, selected, currentUser.userId]);

  // scrolling
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastSelected.current !== selected) {
      el.scrollTop = el.scrollHeight;
      lastSelected.current = selected;
      lastCount.current = thread.length;
      return;
    }
    if (thread.length > lastCount.current) {
      const last = thread[thread.length - 1];
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (nearBottom || last?.senderId === currentUser.userId) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    lastCount.current = thread.length;
  }, [thread, selected, currentUser.userId]);

  // composer
  const autosize = () => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  };
  useEffect(autosize, [text]);

  const pushTyping = useCallback((typing: boolean) => {
    if (!selected) return;
    dbService.setTypingState(currentUser.userId, { isTyping: typing, typingTo: typing ? selected : '', updatedAt: Date.now() }).catch(() => {});
  }, [selected, currentUser.userId]);

  const onType = (val: string) => {
    setText(val);
    pushTyping(val.trim().length > 0);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => pushTyping(false), 2500);
  };

  const send = async (override?: string) => {
    const value = (override ?? text).trim();
    if (!value || !selected) return;

    if (editing) {
      const target = editing;
      setEditing(null); setText('');
      if (value !== target.content) {
        setMessages(prev => prev.map(m => m.id === target.id ? { ...m, content: value, isEdited: true } : m));
        dbService.updateMessage(target.id, { content: value, isEdited: true }).catch(console.error);
      }
      return;
    }

    triggerHapticFeedback('light');
    const msg: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId: currentUser.userId,
      senderName: currentUser.name,
      receiverId: selected,
      content: value,
      createdAt: new Date().toISOString(),
      isRead: false,
    };
    if (replyingTo) {
      msg.replyToId = replyingTo.id;
      msg.replyToContent = replyingTo.content;
      msg.replyToSenderName = replyingTo.senderName;
    }
    pendingRef.current.add(msg.id);
    setMessages(prev => [...prev, msg]);
    if (override === undefined) setText('');
    setReplyingTo(null);
    pushTyping(false);
    try { await dbService.createMessage(msg); } catch (e) { console.error('Failed to send message', e); }
    finally { pendingRef.current.delete(msg.id); }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); }
  };

  // message actions
  const react = (m: Message, emoji: string) => {
    setMenuMsg(null);
    const r = { ...(m.reactions || {}) };
    if (r[currentUser.userId] === emoji) delete r[currentUser.userId]; else r[currentUser.userId] = emoji;
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, reactions: r } : x));
    dbService.updateMessage(m.id, { reactions: r }).catch(console.error);
  };
  const doReply = (m: Message) => { setMenuMsg(null); setEditing(null); setReplyingTo(m); setTimeout(() => inputRef.current?.focus(), 50); };
  const doEdit = (m: Message) => { setMenuMsg(null); setReplyingTo(null); setEditing(m); setText(m.content); setTimeout(() => inputRef.current?.focus(), 50); };
  const doCopy = (m: Message) => { setMenuMsg(null); navigator.clipboard?.writeText(m.content).catch(() => {}); };
  const doPin = (m: Message) => {
    setMenuMsg(null);
    const next = !m.isPinned;
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, isPinned: next } : x));
    dbService.updateMessage(m.id, { isPinned: next, pinnedBy: next ? currentUser.userId : undefined }).catch(console.error);
  };
  const doDelete = (m: Message) => {
    setMenuMsg(null);
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, isDeleted: true, content: 'This message was deleted' } : x));
    dbService.updateMessage(m.id, { isDeleted: true, content: 'This message was deleted' }).catch(console.error);
  };
  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1400);
  }, []);
  const openMenu = useCallback((m: Message) => setMenuMsg(m), []);
  const likeMsg = useCallback((m: Message) => {
    if (m.isDeleted) return;
    // double-tap: add a heart (tapping again on your own heart removes it)
    const r = { ...(m.reactions || {}) };
    if (r[currentUser.userId] === '❤️') delete r[currentUser.userId]; else r[currentUser.userId] = '❤️';
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, reactions: r } : x));
    dbService.updateMessage(m.id, { reactions: r }).catch(console.error);
  }, [currentUser.userId]);
  const swipeReply = useCallback((m: Message) => {
    if (m.isDeleted) return;
    setEditing(null); setReplyingTo(m);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // conversation list
  const convos = useMemo(() => {
    const lastOf = (id: string) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (id === 'all' ? m.receiverId === 'all'
          : (m.senderId === currentUser.userId && m.receiverId === id) || (m.senderId === id && m.receiverId === currentUser.userId)) return m;
      }
      return undefined;
    };
    const unreadOf = (id: string) => id === 'all' ? 0 : messages.filter(m => m.senderId === id && m.receiverId === currentUser.userId && !m.isRead && !m.isDeleted).length;
    const items = [{ id: 'all', name: 'Everyone', group: true }, ...users.map(u => ({ id: u.userId, name: u.name, group: false }))]
      .map(c => ({ ...c, last: lastOf(c.id), unread: unreadOf(c.id) }));
    items.sort((a, b) => (b.last?.createdAt || '').localeCompare(a.last?.createdAt || ''));
    const q = search.trim().toLowerCase();
    const byFilter = filter === 'unread' ? items.filter(c => c.unread > 0) : items;
    return q ? byFilter.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : byFilter;
  }, [messages, users, search, filter, currentUser.userId]);
  const totalUnread = useMemo(() => messages.filter(m => m.receiverId === currentUser.userId && m.senderId !== currentUser.userId && !m.isRead && !m.isDeleted).length, [messages, currentUser.userId]);

  const selectedInfo = selected === 'all'
    ? { name: 'Everyone', group: true }
    : (() => { const u = users.find(x => x.userId === selected); return { name: u ? u.name : `@${selected}`, group: false }; })();

  const pinned = useMemo(() => [...thread].reverse().find(m => m.isPinned && !m.isDeleted), [thread]);

  // last own message receipt (DM only)
  const lastOwn = useMemo(() => [...thread].reverse().find(m => m.senderId === currentUser.userId && !m.isDeleted), [thread, currentUser.userId]);

  const showList = desktop || selected === null;
  const showThread = desktop || selected !== null;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 flex items-end md:items-center justify-center ios-chat" style={{ zIndex: 100000 }}>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-[10px]"
          />
          <motion.div
            initial={desktop ? { opacity: 0, scale: 0.97 } : { y: '100%' }}
            animate={desktop ? { opacity: 1, scale: 1 } : { y: 0 }}
            exit={desktop ? { opacity: 0, scale: 0.97 } : { y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 340, mass: 0.8 }}
            className="relative bg-[#f4f4f4] w-full h-full md:h-[620px] md:max-h-[90vh] md:w-[860px] md:max-w-[96vw] md:rounded-[40px] overflow-hidden shadow-2xl flex"
            style={{ willChange: 'transform' }}
          >
            {/* ===== Conversation list ===== */}
            {showList && (
              <div className={`${desktop ? 'w-[340px] border-r border-neutral-200' : 'w-full'} bg-gradient-to-b from-white to-[#f4f4f4] flex flex-col shrink-0 min-h-0 relative`}>
                <div className="px-4 pb-2 shrink-0" style={{ paddingTop: 'max(env(safe-area-inset-top), 18px)' }}>
                  <div className="flex items-center justify-between">
                    <h1 className="text-[24px] font-semibold text-black tracking-tight">Messages</h1>
                    <button onClick={() => setFilter(f => (f === 'unread' ? 'all' : 'unread'))} className="relative p-2 -mr-2 text-black cursor-pointer active:opacity-50" aria-label="Unread chats">
                      <Bell className="h-[22px] w-[22px]" strokeWidth={1.8} fill={filter === 'unread' ? 'currentColor' : 'none'} />
                      {totalUnread > 0 && <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-black ring-2 ring-white" />}
                    </button>
                  </div>
                  <div className="relative mt-3">
                    <Search className="h-4 w-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.8} />
                    <input
                      id="chat-search-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search chats"
                      className="w-full bg-[#e9e9e9] rounded-full pl-10 pr-9 py-[8px] text-[15px] text-black placeholder-neutral-400 focus:outline-none"
                    />
                    {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 cursor-pointer"><X className="h-4 w-4" /></button>}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto ios-scroll px-4 pb-28 min-h-0">
                  {convos.map(c => {
                    const active = desktop && selected === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => { triggerHapticFeedback('light'); setSelected(c.id); }}
                        className={`w-full flex items-center gap-3 text-left cursor-pointer active:opacity-60 rounded-2xl ${active ? 'bg-black/5' : ''}`}
                      >
                        <Avatar name={c.name} group={c.group} size={48} />
                        <div className="flex-1 min-w-0 py-3 border-b border-neutral-200">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[16px] text-black truncate">{cleanName(c.name)}</span>
                            <span className="text-[11px] text-neutral-500 shrink-0">{listTime(c.last?.createdAt)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-1">
                            <p className="text-[14px] text-neutral-500 truncate">
                              {c.last
                                ? `${c.group && c.last.senderId !== currentUser.userId ? cleanName(c.last.senderName) + ': ' : ''}${c.last.isDeleted ? 'Message deleted' : c.last.content}`
                                : c.group ? 'Chat with everyone' : 'No messages yet'}
                            </p>
                            {c.unread > 0 && (
                              <span className="shrink-0 bg-black text-white text-[11px] font-medium rounded-full min-w-[22px] h-[22px] px-1.5 flex items-center justify-center">{c.unread > 99 ? '99+' : c.unread}</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {convos.length === 0 && <p className="text-center text-neutral-400 text-[15px] py-10">{filter === 'unread' ? 'No unread chats' : 'No results'}</p>}
                </div>

                {/* floating + with popup menu */}
                <AnimatePresence>
                  {fabOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setFabOpen(false)} />
                      <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 10 }}
                        transition={{ type: 'spring', damping: 24, stiffness: 400 }}
                        style={{ transformOrigin: 'bottom right' }}
                        className="absolute right-4 bottom-[90px] z-20 bg-black/80 rounded-[22px] shadow-xl py-2 w-[160px]"
                      >
                        <button onClick={() => { setFabOpen(false); setSelected('all'); }} className="w-full text-left px-5 py-2.5 text-[15px] text-white active:bg-neutral-100 cursor-pointer">Everyone</button>
                        {users.map(u => (
                          <button key={u.userId} onClick={() => { setFabOpen(false); setSelected(u.userId); }} className="w-full text-left px-5 py-2.5 text-[15px] text-white active:bg-neutral-100 cursor-pointer">{cleanName(u.name)}</button>
                        ))}
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
                <button
                  onClick={() => setFabOpen(o => !o)}
                  aria-label="New chat"
                  className="absolute right-2 bottom-[19.1px] z-20 h-[52px] w-[52px] rounded-full bg-black text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform cursor-pointer"
                >
                  <Plus className={`h-6 w-6 transition-transform ${fabOpen ? 'rotate-45' : ''}`} strokeWidth={2} />
                </button>

                {/* floating black pill */}
                <div className="absolute left-2 -translate-x-0 z-20 bg-black rounded-full h-[56px] px-8 flex items-center gap-8 shadow-xl" style={{ bottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
                  <button onClick={() => setFilter('all')} aria-label="All chats" className={`cursor-pointer active:scale-90 transition-all ${filter === 'all' ? 'text-white' : 'text-neutral-500'}`}>
                    <MessageCircle className="h-[26px] w-[26px]" strokeWidth={1.8} />
                  </button>
                  <button onClick={() => setFilter('unread')} aria-label="Unread" className={`relative cursor-pointer active:scale-90 transition-all ${filter === 'unread' ? 'text-white' : 'text-neutral-500'}`}>
                    <Bell className="h-[26px] w-[26px]" strokeWidth={1.8} />
                    {totalUnread > 0 && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-white" />}
                  </button>
                  <button onClick={() => setOpen(false)} aria-label="Close" className="text-neutral-500 cursor-pointer active:scale-90 transition-all">
                    <X className="h-[26px] w-[26px]" strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            )}

            {/* ===== Thread ===== */}
            {showThread && (
              <div className="flex-1 min-w-0 flex flex-col bg-[#f4f4f4] relative min-h-0">
                {selected ? (
                  <>
                    <div className="bg-white border-b border-neutral-200 shrink-0 px-2.5 pb-2 z-10" style={{ paddingTop: 'max(env(safe-area-inset-top), 14px)' }}>
                      <div className="flex items-center gap-2">
                        {!desktop && (
                          <button onClick={() => setSelected(null)} className="text-black active:opacity-50 cursor-pointer p-1" aria-label="Back">
                            <ChevronLeft className="h-6 w-6" strokeWidth={2} />
                          </button>
                        )}
                        <Avatar name={selectedInfo.name} group={selectedInfo.group} size={38} />
                        <div className="flex-1 min-w-0 ml-1">
                          <p className="text-[15px] font-medium text-black truncate leading-tight">{cleanName(selectedInfo.name)}</p>
                          <p className="text-[12px] text-neutral-500 truncate">
                            {partnerTyping ? 'typing…' : selected === 'all' ? 'Group · everyone' : `@${selected}`}
                          </p>
                        </div>
                        <div className="relative">
                          <button onClick={() => setHeadMenu(o => !o)} className="p-2 text-black cursor-pointer active:opacity-50" aria-label="More">
                            <MoreVertical className="h-5 w-5" />
                          </button>
                          <AnimatePresence>
                            {headMenu && (
                              <>
                                <div className="fixed inset-0 z-20" onClick={() => setHeadMenu(false)} />
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
                                  style={{ transformOrigin: 'top right' }}
                                  className="absolute right-0 top-10 z-30 bg-black/90 rounded-2xl shadow-xl py-2 w-[170px]"
                                >
                                  {pinned && <button onClick={() => { setHeadMenu(false); jumpTo(pinned.id); }} className="w-full text-left px-5 py-2.5 text-[16px] text-white active:bg-black cursor-pointer">Go to pinned</button>}
                                  <button onClick={() => { setHeadMenu(false); setOpen(false); }} className="w-full text-left px-5 py-2.5 text-[16px] text-white active:bg-black cursor-pointer">Close chat</button>
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                      {pinned && (
                        <button onClick={() => jumpTo(pinned.id)} className="mt-2 w-full flex items-center gap-2 bg-[#f4f4f4] rounded-full px-4 py-2 text-left cursor-pointer active:opacity-60">
                          <Pin className="h-3.5 w-3.5 text-black shrink-0" />
                          <span className="text-[13px] text-neutral-600 truncate"><b className="text-black">Pinned</b> · {pinned.content}</span>
                        </button>
                      )}
                    </div>

                    <div ref={scrollRef} className="flex-1 overflow-y-auto ios-scroll px-3 py-3 min-h-0">
                      {thread.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-neutral-400 gap-2">
                          <MessageCircle className="h-10 w-10" strokeWidth={1.5} />
                          <p className="text-[15px]">No messages yet. Say hello 👋</p>
                        </div>
                      )}
                      {thread.map((m, i) => {
                        const prev = thread[i - 1], next = thread[i + 1];
                        const mine = m.senderId === currentUser.userId;
                        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                        const firstOfGroup = !prev || newDay || prev.senderId !== m.senderId || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000;
                        const lastOfGroup = !next || next.senderId !== m.senderId || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString() || new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime() > 5 * 60 * 1000;
                        return (
                          <React.Fragment key={m.id}>
                            {newDay && <div className="text-center text-[12px] text-neutral-400 font-medium mt-3 mb-3">{dayLabel(m.createdAt)}</div>}
                            <Bubble
                              msg={m}
                              mine={mine}
                              showName={selected === 'all' && !mine && firstOfGroup}
                              tail={lastOfGroup}
                              gapTop={firstOfGroup && !newDay}
                              flash={flashId === m.id}
                              receipt={selected !== 'all' && lastOwn?.id === m.id ? (m.isRead ? 'Seen' : 'Sent') : undefined}
                              onMenu={openMenu}
                              onJump={jumpTo}
                              onLike={likeMsg}
                              onReply={swipeReply}
                            />
                          </React.Fragment>
                        );
                      })}
                      {partnerTyping && (
                        <div className="mt-3 flex">
                          <div className="bg-white rounded-[24px] rounded-bl-[6px] px-5 py-4 flex gap-1">
                            {[0, 1, 2].map(d => (
                              <motion.span key={d} className="h-2 w-2 rounded-full bg-neutral-400" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: d * 0.18 }} />
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="h-2" />
                    </div>

                    {/* composer */}
                    <div className="bg-white border-t border-neutral-200 shrink-0 px-3 pt-2" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 10px)' }}>
                      <AnimatePresence initial={false}>
                        {(replyingTo || editing) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="flex items-center gap-2 mb-3 pl-3 border-l-2 border-black">
                              <div className="flex-1 min-w-0">
                                <p className="text-[12px] font-semibold text-black">{editing ? 'Editing message' : `Replying to ${cleanName(replyingTo!.senderName)}`}</p>
                                <p className="text-[13px] text-neutral-500 truncate">{(editing || replyingTo)!.content}</p>
                              </div>
                              <button onClick={() => { setReplyingTo(null); setEditing(null); if (editing) setText(''); }} className="text-neutral-400 cursor-pointer p-1"><X className="h-4 w-4" /></button>
                            </div>
                          </motion.div>
                        )}
                        {emojiBar && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="flex gap-1 mb-3 overflow-x-auto">
                              {['😀', '😂', '🙏', '👍', '❤️', '🎉', '👏', '🔥', '😊', '✅'].map(e => (
                                <button key={e} onClick={() => { setText(t => t + e); inputRef.current?.focus(); }} className="h-10 w-10 shrink-0 rounded-full bg-[#f4f4f4] text-[22px] flex items-center justify-center cursor-pointer active:scale-90">{e}</button>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                      <div className="flex items-end gap-2">
                        <button onClick={() => setEmojiBar(o => !o)} aria-label="Emoji" className="h-[34px] w-[34px] shrink-0 rounded-full bg-neutral-300 text-white flex items-center justify-center cursor-pointer active:scale-90 transition-transform">
                          {emojiBar ? <Smile className="h-5 w-5 text-black" /> : <Plus className="h-5 w-5" strokeWidth={2.2} />}
                        </button>
                        <textarea
                          ref={inputRef}
                          value={text}
                          rows={1}
                          onChange={e => onType(e.target.value)}
                          onKeyDown={onKeyDown}
                          placeholder="Message"
                          className="flex-1 resize-none bg-transparent text-[15px] leading-[20px] py-[7px] placeholder-neutral-400 focus:outline-none max-h-[110px]"
                        />
                        {text.trim() || editing ? (
                          <button
                            onClick={() => void send()}
                            aria-label="Send"
                            className="h-[36px] w-[36px] shrink-0 rounded-full bg-black text-white flex items-center justify-center transition-all cursor-pointer active:scale-90"
                          >
                            {editing ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
                          </button>
                        ) : (
                          <button
                            onClick={() => { triggerHapticFeedback('light'); void send('❤️'); }}
                            aria-label="Send a heart"
                            className="h-[36px] w-[36px] shrink-0 rounded-full flex items-center justify-center transition-all cursor-pointer active:scale-75 text-black"
                          >
                            <Heart className="h-[22px] w-[22px]" strokeWidth={1.8} />
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 gap-2">
                    <MessageCircle className="h-12 w-12" strokeWidth={1.4} />
                    <p className="text-[17px]">Select a conversation</p>
                  </div>
                )}
              </div>
            )}

            {/* ===== Long-press context menu ===== */}
            <AnimatePresence>
              {menuMsg && (
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                  className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 px-8 bg-black/30 backdrop-blur-md"
                  onClick={() => setMenuMsg(null)}
                >
                  <motion.div
                    initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                    transition={{ type: 'spring', damping: 24, stiffness: 420 }}
                    onClick={e => e.stopPropagation()}
                    className="flex flex-col items-stretch gap-3 w-full max-w-[280px]"
                  >
                    <div className="bg-white/95 rounded-full shadow-xl px-2 py-1.5 flex justify-between">
                      {EMOJIS.map(e => (
                        <button key={e} onClick={() => react(menuMsg, e)}
                          className={`h-10 w-10 rounded-full text-[24px] flex items-center justify-center cursor-pointer active:scale-125 transition-transform ${menuMsg.reactions?.[currentUser.userId] === e ? 'bg-neutral-200' : ''}`}>{e}</button>
                      ))}
                    </div>
                    <div className="bg-white/95 rounded-2xl shadow-xl overflow-hidden divide-y divide-neutral-200/80">
                      <MenuItem icon={CornerUpLeft} label="Reply" onClick={() => doReply(menuMsg)} />
                      <MenuItem icon={Copy} label="Copy" onClick={() => doCopy(menuMsg)} />
                      {menuMsg.senderId === currentUser.userId && <MenuItem icon={Pencil} label="Edit" onClick={() => doEdit(menuMsg)} />}
                      <MenuItem icon={Pin} label={menuMsg.isPinned ? 'Unpin' : 'Pin'} onClick={() => doPin(menuMsg)} />
                      {menuMsg.senderId === currentUser.userId && <MenuItem icon={Trash2} label="Delete" danger onClick={() => doDelete(menuMsg)} />}
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center justify-between px-4 py-3 text-[17px] active:bg-neutral-200 cursor-pointer ${danger ? 'text-red-500' : 'text-black'}`}>
      {label}
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}