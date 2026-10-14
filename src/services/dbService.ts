import { User, TransactionRecord, Organization, Notice, Message } from '../types';

const LOCAL_KEYS = {
  USERS: 'mvp_local_users', RECORDS: 'mvp_local_records', ORG: 'mvp_local_org',
  NOTICES: 'mvp_local_notices', MESSAGES: 'mvp_local_messages',
};

export async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getSessionToken(): string {
  try { return JSON.parse(localStorage.getItem('mvp_finance_session') || '{}').sessionToken || ''; } catch { return ''; }
}
function authHeaders(): HeadersInit {
  const token = getSessionToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Database request failed (${response.status})`);
  return body as T;
}
function readLocal<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
function writeLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* local cache is best-effort */ } }

async function ensureLocalSeeded() {
  if (!localStorage.getItem(LOCAL_KEYS.ORG)) writeLocal(LOCAL_KEYS.ORG, { id:'mvp_org', organizationName:'MVP-Ledger', createdAt:new Date().toISOString() });
  if (!localStorage.getItem(LOCAL_KEYS.USERS)) {
    const now = new Date().toISOString();
    writeLocal(LOCAL_KEYS.USERS, [
      { id:'user_superadmin', userId:'superadmin', name:'John Miller (Trustee)', passwordHash:await hashPassword('admin123'), role:'Super Admin', status:'active', createdAt:now, updatedAt:now },
      { id:'user_admin', userId:'admin', name:'Alice Smith (Trustee)', passwordHash:await hashPassword('admin123'), role:'Admin', status:'active', createdAt:now, updatedAt:now },
      { id:'user_aarthik1', userId:'aarthik1', name:'Robert Johnson (Finance Manager)', passwordHash:await hashPassword('aarthik123'), role:'Finance Manager', status:'active', createdAt:now, updatedAt:now },
    ]);
  }
  if (!localStorage.getItem(LOCAL_KEYS.RECORDS)) writeLocal(LOCAL_KEYS.RECORDS, []);
  if (!localStorage.getItem(LOCAL_KEYS.NOTICES)) writeLocal(LOCAL_KEYS.NOTICES, []);
  if (!localStorage.getItem(LOCAL_KEYS.MESSAGES)) writeLocal(LOCAL_KEYS.MESSAGES, []);
}

async function list<T>(collection: string, localKey: string): Promise<T[]> {
  try { const result = await api<{data:T[]}>(`/api/data/${collection}`); writeLocal(localKey, result.data || []); return result.data || []; }
  catch (error) { console.warn(`PostgreSQL ${collection} request failed; using local cache`, error); await ensureLocalSeeded(); return readLocal<T[]>(localKey, []); }
}
async function create<T extends {id:string}>(collection: string, localKey: string, item: T) {
  const current = readLocal<T[]>(localKey, []); writeLocal(localKey, [...current.filter(x => x.id !== item.id), item]);
  await api(`/api/data/${collection}`, { method:'POST', body:JSON.stringify(item) });
}
async function update<T extends {id:string}>(collection: string, localKey: string, id: string, patch: Partial<T>) {
  const current = readLocal<T[]>(localKey, []); writeLocal(localKey, current.map(item => item.id === id ? { ...item, ...patch } : item));
  await api(`/api/data/${collection}/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(patch) });
}
async function remove<T extends {id:string}>(collection: string, localKey: string, id: string) {
  writeLocal(localKey, readLocal<T[]>(localKey, []).filter(item => item.id !== id));
  await api(`/api/data/${collection}/${encodeURIComponent(id)}`, { method:'DELETE' });
}

export const dbService = {
  async bootstrapDataIfNeeded(): Promise<void> {
    await ensureLocalSeeded();
    try {
      await api('/api/bootstrap', { method:'POST', body:'{}' });
      // Refresh caches when an existing authenticated session is available.
      if (getSessionToken()) {
        await Promise.allSettled([
          this.getUsers(), this.getRecords(), this.getNotices(), this.getMessages(), this.getOrganization(),
        ]);
      }
    } catch (error) { console.warn('PostgreSQL bootstrap unavailable; local cache remains available.', error); }
  },

  async getUsers(): Promise<User[]> {
    try { const result = await api<{data:User[]}>('/api/data/users'); writeLocal(LOCAL_KEYS.USERS, result.data || []); return result.data || []; }
    catch { await ensureLocalSeeded(); return readLocal<User[]>(LOCAL_KEYS.USERS, []); }
  },
  async getUserByUserId(userId: string): Promise<User | null> {
    try {
      const result = await api<{data:User[]}>(`/api/data/users?field=userId&value=${encodeURIComponent(userId)}`);
      const user = (result.data || [])[0] || null;
      if (user?.passwordHash) {
        const users = readLocal<User[]>(LOCAL_KEYS.USERS, []); writeLocal(LOCAL_KEYS.USERS, [...users.filter(u => u.id !== user.id), user]);
      }
      return user;
    } catch { await ensureLocalSeeded(); return readLocal<User[]>(LOCAL_KEYS.USERS, []).find(u => u.userId === userId) || null; }
  },
  async createUser(user: User): Promise<void> { await create('users', LOCAL_KEYS.USERS, user); },
  async updateUser(id: string, data: Partial<User>): Promise<void> { await update<User>('users', LOCAL_KEYS.USERS, id, { ...data, updatedAt:new Date().toISOString() }); },
  async deleteUser(id: string): Promise<void> { await remove<User>('users', LOCAL_KEYS.USERS, id); },

  async getRecords(): Promise<TransactionRecord[]> { return (await list<TransactionRecord>('records', LOCAL_KEYS.RECORDS)).sort((a,b) => b.transactionDate.localeCompare(a.transactionDate)); },
  async createRecord(record: TransactionRecord): Promise<void> { await create('records', LOCAL_KEYS.RECORDS, record); },
  async updateRecord(id: string, data: Partial<TransactionRecord>): Promise<void> { await update<TransactionRecord>('records', LOCAL_KEYS.RECORDS, id, { ...data, updatedAt:new Date().toISOString() }); },
  async deleteRecord(id: string): Promise<void> { await remove<TransactionRecord>('records', LOCAL_KEYS.RECORDS, id); },

  async getOrganization(): Promise<Organization> {
    try {
      const result = await api<{data:Organization[]}>(`/api/data/organization?field=id&value=mvp_org`);
      const org = result.data?.[0];
      if (org) { writeLocal(LOCAL_KEYS.ORG, org); return org; }
    } catch { /* use cache */ }
    await ensureLocalSeeded(); return readLocal<Organization>(LOCAL_KEYS.ORG, {id:'mvp_org',organizationName:'MVP-Ledger',createdAt:new Date().toISOString()});
  },
  async updateOrganization(data: Partial<Organization>): Promise<void> {
    const org = { ...readLocal<Organization>(LOCAL_KEYS.ORG, {id:'mvp_org',organizationName:'MVP-Ledger',createdAt:new Date().toISOString()}), ...data };
    writeLocal(LOCAL_KEYS.ORG, org);
    await api('/api/data/organization', { method:'POST', body:JSON.stringify(org) });
  },

  async getNotices(): Promise<Notice[]> { return (await list<Notice>('notices', LOCAL_KEYS.NOTICES)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); },
  async createNotice(notice: Notice): Promise<void> { await create('notices', LOCAL_KEYS.NOTICES, notice); },
  async deleteNotice(id: string): Promise<void> { await remove<Notice>('notices', LOCAL_KEYS.NOTICES, id); },
  async resolveNotice(id: string): Promise<void> { await update<Notice>('notices', LOCAL_KEYS.NOTICES, id, {status:'resolved'}); },

  async getMessages(): Promise<Message[]> { return (await list<Message>('messages', LOCAL_KEYS.MESSAGES)).sort((a,b) => a.createdAt.localeCompare(b.createdAt)); },
  subscribeMessages(callback: (messages: Message[]) => void, intervalMs = 3000): () => void {
    let stopped = false;
    const refresh = async () => { try { const messages = await this.getMessages(); if (!stopped) callback(messages); } catch { if (!stopped) callback(readLocal<Message[]>(LOCAL_KEYS.MESSAGES, [])); } };
    void refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => { stopped = true; window.clearInterval(timer); };
  },
  async createMessage(message: Message): Promise<void> { await create('messages', LOCAL_KEYS.MESSAGES, message); },
  async updateMessage(id: string, updates: Partial<Message>): Promise<void> { await update<Message>('messages', LOCAL_KEYS.MESSAGES, id, updates); },
  async deleteMessage(id: string): Promise<void> { await remove<Message>('messages', LOCAL_KEYS.MESSAGES, id); },

  async getTypingState(userId: string): Promise<any> {
    const result = await api<{data:any}>(`/api/typing/${encodeURIComponent(userId)}`); return result.data;
  },
  async setTypingState(userId: string, state: {isTyping:boolean; typingTo:string; updatedAt:number}): Promise<void> {
    await api(`/api/typing/${encodeURIComponent(userId)}`, { method:'PUT', body:JSON.stringify(state) });
  },
};
