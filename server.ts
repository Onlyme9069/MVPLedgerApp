import express from 'express';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import webpush from 'web-push';
import { createServer as createViteServer } from 'vite';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

dotenv.config();

// PostgreSQL/Neon database. All database credentials stay on the server.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  connectionTimeoutMillis: 10000,
});

const ALLOWED_COLLECTIONS = new Set(['users', 'records', 'organization', 'notices', 'messages', 'sessions', 'challenges', 'typing_states', 'push_subscriptions']);
const DB_FIELD_DELETE = '__MVP_DB_DELETE__';
const FieldValue = { delete: () => ({ [DB_FIELD_DELETE]: true }) };
let schemaReady: Promise<void> | null = null;
async function ensureSchema() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Copy .env.example to .env and configure your PostgreSQL connection.');
  if (!schemaReady) schemaReady = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_documents (
      collection_name text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection_name, id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS app_documents_collection_idx ON app_documents (collection_name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS app_documents_userid_idx ON app_documents (collection_name, (data->>'userId'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS app_documents_createdat_idx ON app_documents (collection_name, (data->>'createdAt'))`);
  })();
  return schemaReady;
}
function assertCollection(name: string) {
  if (!ALLOWED_COLLECTIONS.has(name)) throw new Error('Unsupported database collection');
}
function toDoc(row: any, ref: DocRefWrapper) {
  return { exists: !!row, id: row?.id || ref.docId, ref, data: () => row?.data };
}
class DocRefWrapper {
  constructor(public colPath: string, public docId: string) { assertCollection(colPath); }
  get path() { return `${this.colPath}/${this.docId}`; }
  async get() {
    await ensureSchema();
    const result = await pool.query('SELECT id, data FROM app_documents WHERE collection_name=$1 AND id=$2', [this.colPath, this.docId]);
    return toDoc(result.rows[0], this);
  }
  async set(data: any) {
    await ensureSchema();
    const safe = { ...(data || {}), id: data?.id || this.docId };
    await pool.query(`INSERT INTO app_documents(collection_name,id,data) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(collection_name,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [this.colPath, this.docId, JSON.stringify(safe)]);
  }
  async update(data: any) {
    await ensureSchema();
    const current = await this.get();
    if (!current.exists) throw new Error(`Document not found: ${this.path}`);
    const patch = { ...(data || {}) };
    const removals = Object.keys(patch).filter(k => patch[k] && patch[k][DB_FIELD_DELETE]);
    for (const key of removals) delete patch[key];
    let merged = { ...current.data(), ...patch, id: this.docId };
    for (const key of removals) delete (merged as any)[key];
    await pool.query('UPDATE app_documents SET data=$3::jsonb, updated_at=now() WHERE collection_name=$1 AND id=$2', [this.colPath, this.docId, JSON.stringify(merged)]);
  }
  async delete() { await ensureSchema(); await pool.query('DELETE FROM app_documents WHERE collection_name=$1 AND id=$2', [this.colPath, this.docId]); }
}
class QueryWrapper {
  private constraints: Array<{field:string; op:string; value:any}> = [];
  constructor(private colPath: string) { assertCollection(colPath); }
  where(field: string, op: any, value: any) { this.constraints.push({ field, op, value }); return this; }
  async get() {
    await ensureSchema();
    let sql = 'SELECT id, data FROM app_documents WHERE collection_name=$1';
    const params: any[] = [this.colPath];
    for (const item of this.constraints) {
      if (!/^[a-zA-Z0-9_]+$/.test(item.field) || !['==','<','<=','>','>=','!='].includes(item.op)) throw new Error('Unsupported database query');
      params.push(item.field, item.value);
      const n = params.length;
      if (typeof item.value === 'number') {
        const expr = `CASE WHEN jsonb_typeof(data->$${n-1})='number' THEN (data->>$${n-1})::numeric ELSE NULL END`;
        sql += ` AND ${expr} ${item.op === '==' ? '=' : item.op} $${n}::numeric`;
      } else {
        const expr = `data->>$${n-1}`;
        sql += ` AND ${expr} ${item.op === '==' ? '=' : item.op} $${n}::text`;
      }
    }
    const result = await pool.query(sql, params);
    const docs = result.rows.map(row => ({ id: row.id, ref: new DocRefWrapper(this.colPath, row.id), data: () => row.data }));
    return { empty: docs.length === 0, size: docs.length, docs, forEach(cb: (doc:any)=>void) { docs.forEach(cb); } };
  }
}
class CollectionWrapper {
  constructor(private colPath: string) { assertCollection(colPath); }
  doc(docId: string) { return new DocRefWrapper(this.colPath, docId); }
  where(field: string, op: any, value: any) { return new QueryWrapper(this.colPath).where(field, op, value); }
  async get() { return new QueryWrapper(this.colPath).get(); }
}
class BatchWrapper {
  private refs: DocRefWrapper[] = [];
  delete(ref: DocRefWrapper) { this.refs.push(ref); return this; }
  async commit() {
    await ensureSchema();
    const client = await pool.connect();
    try { await client.query('BEGIN'); for (const ref of this.refs) await client.query('DELETE FROM app_documents WHERE collection_name=$1 AND id=$2', [ref.colPath, ref.docId]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
const db = {
  collection(colPath: string) { return new CollectionWrapper(colPath); },
  batch() { return new BatchWrapper(); }
};

const app = express();
// Behind Render's reverse proxy: use the real client IP (X-Forwarded-For) so rate limits are per user, not shared by everyone.
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT,10): 3000;

app.use(express.json());

// Durable sessions and WebAuthn challenges are stored in PostgreSQL.
interface Session {
  userId: string;
  userDocId: string;
  role: string;
  name: string;
  createdAt: number;
}

interface Challenge {
  challenge: string;
  userId: string;
  expires: number;
}

// Cleanup interval for expired PostgreSQL sessions and challenges
setInterval(async () => {
  try {
    const now = Date.now();
    const fourHoursAgo = now - 3600 * 1000 * 4;

    // Delete expired sessions
    const expiredSessions = await db.collection('sessions')
      .where('createdAt', '<', fourHoursAgo)
      .get();
    
    const batch = db.batch();
    expiredSessions.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete expired challenges
    const expiredChallenges = await db.collection('challenges')
      .where('expires', '<', now)
      .get();
    
    expiredChallenges.forEach(doc => {
      batch.delete(doc.ref);
    });

    if (expiredSessions.size > 0 || expiredChallenges.size > 0) {
      await batch.commit();
      console.log(`[SESSION CLEANUP] Cleaned up ${expiredSessions.size} expired sessions and ${expiredChallenges.size} expired challenges.`);
    }
  } catch (err) {
    console.error('[SESSION CLEANUP] Error during periodic cleanup:', err);
  }
}, 10 * 60 * 1000);

// Helper to determine RP ID and origin dynamically from the request headers
const getRpID = (req: express.Request): string => {
  const host = req.get('host') || 'localhost';
  return host.split(':')[0];
};

const getOrigin = (req: express.Request): string => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const protocol = isHttps ? 'https' : 'http';
  const host = req.get('host') || 'localhost:3000';
  return `${protocol}://${host}`;
};

// 2. Authentication Middleware
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token || token === 'undefined') {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }

    const sessionDoc = await db.collection('sessions').doc(token).get();
    if (!sessionDoc.exists) {
      return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    }

    const session = sessionDoc.data() as Session;
    const now = Date.now();

    // Enforce 4-hour session lifespan
    if (now - session.createdAt > 3600 * 1000 * 4) {
      await db.collection('sessions').doc(token).delete();
      return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    }

    // Inject session details into request
    (req as any).session = session;
    next();
  } catch (err) {
    console.error('requireAuth middleware error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred verifying your session.' });
  }
};

// Rate limiting map for security
const RATE_LIMIT_WINDOW_MS = 60000;
const rateLimits = new Map<string, { count: number; lastReset: number }>();
const checkRateLimit = (key: string, limit = 60, windowMs = RATE_LIMIT_WINDOW_MS) => {
  const now = Date.now();
  const record = rateLimits.get(key) || { count: 0, lastReset: now };
  if (now - record.lastReset > windowMs) {
    record.count = 0;
    record.lastReset = now;
  }
  record.count++;
  rateLimits.set(key, record);
  return record.count <= limit;
};

// Drop stale rate-limit entries so the map cannot grow without bound.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [key, record] of rateLimits) {
    if (record.lastReset < cutoff) rateLimits.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS * 5).unref();

app.use((req, res, next) => {
  // HTTPS & Security Headers
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Serve PWA Service Worker with no-cache so updates register instantly
  if (req.path === '/sw.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (req.path === '/manifest.json') {
    res.setHeader('Content-Type', 'application/manifest+json');
  }

  // Rate-limit API calls only. Static assets and Vite dev modules must never be throttled,
  // otherwise a normal page load can trip the limit. Login/biometric endpoints keep the
  // strict limit (brute-force protection); other API routes get headroom for the app's
  // short-polling (messages, typing, notices).
  if (req.path.startsWith('/api')) {
    const ip = req.ip || 'unknown';
    const isAuthRoute = req.path.startsWith('/api/auth') || req.path.startsWith('/api/webauthn');
    const allowed = isAuthRoute ? checkRateLimit(`auth:${ip}`, 60) : checkRateLimit(`api:${ip}`, 600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
  }
  next();
});

// ==========================================
// API ENDPOINTS
// ==========================================

// Standard healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Initialize a fresh schema and seed the same starter data only when the new database is empty.
app.post('/api/bootstrap', async (_req, res) => {
  try {
    await ensureSchema();
    const users = await db.collection('users').get();
    if (users.empty) {
      const now = new Date().toISOString();
      const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
      const seedUsers = [
        { id:'user_superadmin', userId:'superadmin', name:'John Miller (Trustee)', passwordHash:hash('admin123'), role:'Super Admin', status:'active', createdAt:now, updatedAt:now },
        { id:'user_admin', userId:'admin', name:'Alice Smith (Trustee)', passwordHash:hash('admin123'), role:'Admin', status:'active', createdAt:now, updatedAt:now },
        { id:'user_aarthik1', userId:'aarthik1', name:'Robert Johnson (Finance Manager)', passwordHash:hash('aarthik123'), role:'Finance Manager', status:'active', createdAt:now, updatedAt:now }
      ];
      for (const user of seedUsers) await db.collection('users').doc(user.id).set(user);
      // Sample transactions are no longer hard-coded here. Use `npm run seed:transactions` to add demo data to the database.
      await db.collection('organization').doc('mvp_org').set({ id:'mvp_org', organizationName:'MVP-Ledger', createdAt:now });
    }
    res.json({ success:true, database:'postgresql', seeded: users.empty });
  } catch (error:any) { console.error('Database bootstrap failed:', error); res.status(500).json({ error:'Database initialization failed. Check DATABASE_URL.' }); }
});

// Generic data API. User directory responses omit password hashes and biometric secrets.
app.get('/api/data/:collection', async (req, res) => {
  try {
    const collection = String(req.params.collection);
    if (!ALLOWED_COLLECTIONS.has(collection) || ['sessions','challenges','typing_states','push_subscriptions'].includes(collection)) return res.status(404).json({error:'Collection not found'});
    let session: any = null;
    const token = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization!.slice(7) : '';
    if (token) { const snap = await db.collection('sessions').doc(token).get(); if (snap.exists && Date.now() - snap.data().createdAt <= 4*60*60*1000) session = snap.data(); }
    if (!session && collection !== 'users') return res.status(401).json({error:'Authentication required'});
    let query: any = db.collection(collection);
    if (req.query.field && req.query.value !== undefined) query = query.where(String(req.query.field), '==', String(req.query.value));
    const result = await query.get();
    let docs = result.docs.map((doc:any) => doc.data());
    if (collection === 'users') docs = docs.map((u:any) => { const { passwordHash, biometricCredentialId, biometricPublicKey, biometricCounter, ...safeUser } = u; return safeUser; });
    res.json({ data:docs });
  } catch (error:any) { console.error('Data read failed:', error); res.status(500).json({error:'Unable to read database records'}); }
});
app.post('/api/data/:collection', requireAuth, async (req, res) => {
  try { const collection=String(req.params.collection); if (!ALLOWED_COLLECTIONS.has(collection) || ['sessions','challenges','typing_states','push_subscriptions'].includes(collection)) return res.status(404).json({error:'Collection not found'}); const data=req.body || {}; if (!data.id) return res.status(400).json({error:'Record id is required'}); await db.collection(collection).doc(String(data.id)).set(data); res.json({success:true}); if (collection === 'records') scheduleSheetsAutoSync(); if (collection === 'messages' || collection === 'notices') void sendPushFor(collection, data); }
  catch(error:any) { console.error('Data create failed:',error); res.status(500).json({error:'Unable to save record'}); }
});
app.patch('/api/data/:collection/:id', requireAuth, async (req, res) => {
  try { const collection=String(req.params.collection); if (!ALLOWED_COLLECTIONS.has(collection) || ['sessions','challenges','typing_states','push_subscriptions'].includes(collection)) return res.status(404).json({error:'Collection not found'}); await db.collection(collection).doc(String(req.params.id)).update(req.body || {}); res.json({success:true}); if (collection === 'records') scheduleSheetsAutoSync(); }
  catch(error:any) { console.error('Data update failed:',error); res.status(500).json({error:'Unable to update record'}); }
});
app.delete('/api/data/:collection/:id', requireAuth, async (req, res) => {
  try { const collection=String(req.params.collection); if (!ALLOWED_COLLECTIONS.has(collection) || ['sessions','challenges','typing_states','push_subscriptions'].includes(collection)) return res.status(404).json({error:'Collection not found'}); await db.collection(collection).doc(String(req.params.id)).delete(); res.json({success:true}); if (collection === 'records') scheduleSheetsAutoSync(); }
  catch(error:any) { console.error('Data delete failed:',error); res.status(500).json({error:'Unable to delete record'}); }
});
app.get('/api/typing/:userId', requireAuth, async (req,res) => { try { const snap=await db.collection('typing_states').doc(String(req.params.userId)).get(); res.json({data:snap.exists?snap.data():null}); } catch(e) { res.status(500).json({error:'Unable to read typing state'}); } });
app.put('/api/typing/:userId', requireAuth, async (req,res) => { try { await db.collection('typing_states').doc(String(req.params.userId)).set({...req.body,id:String(req.params.userId)}); res.json({success:true}); } catch(e) { res.status(500).json({error:'Unable to update typing state'}); } });


// ==========================================
// WEB PUSH (works with the app closed: Android, desktop, iOS 16.4+ installed PWA)
// Needs VAPID keys in env: `npx web-push generate-vapid-keys`
// ==========================================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[PUSH] VAPID keys not set - background push notifications are disabled.');
}
const subId = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);
const trunc = (t: string, n = 90) => (t.length > n ? t.slice(0, n) + '...' : t);
const inr = (n: number) => '\u20B9' + Number(n || 0).toLocaleString('en-IN');

async function sendPushFor(collection: string, data: any) {
  if (!pushEnabled || !data) return;
  try {
    const subsSnap = await db.collection('push_subscriptions').get();
    const subs = subsSnap.docs.map((d: any) => d.data());
    if (!subs.length) return;

    let payload: any;
    let allow: (s: any, role?: string) => boolean;
    let needRoles = false;

    if (collection === 'messages') {
      if (data.isDeleted) return;
      const chatId = data.receiverId === 'all' ? 'all' : data.senderId;
      payload = { title: `${data.senderName || data.senderId} sent you a message`, body: trunc(String(data.content || '')), tag: `chat-${chatId}`, open: 'chat', with: chatId, url: `/?open=chat&with=${encodeURIComponent(chatId)}` };
      allow = (s) => s.userId !== data.senderId && (data.receiverId === 'all' || s.userId === data.receiverId);
    } else if (collection === 'notices') {
      let title: string;
      if (data.kind === 'payment') {
        const party = data.paymentParty || String(data.reason || '').replace(/^(Paid to|Received from)\s+/i, '');
        title = data.paymentDirection === 'received'
          ? `Mission Vikram Prakalp received payment of ${inr(data.recordAmount)} from ${party}`
          : `Mission Vikram Prakalp made payment of ${inr(data.recordAmount)} to ${party}`;
      } else {
        title = `${data.reporterName || data.reportedBy} raised dispute of ${inr(data.recordAmount)}`;
      }
      payload = { title, body: trunc(String(data.recordPurpose || '')), tag: `notice-${data.id}`, open: 'notices', url: '/?open=notices' };
      needRoles = true; // viewers have no notices tab
      allow = (s, role) => s.userId !== data.reportedBy && role !== 'Viewer';
    } else {
      return;
    }

    const roleByUser = new Map<string, string>();
    if (needRoles) {
      const usersSnap = await db.collection('users').get();
      usersSnap.docs.forEach((d: any) => roleByUser.set(d.data().userId, d.data().role));
    }

    const body = JSON.stringify(payload);
    await Promise.all(subs.filter((s: any) => allow(s, roleByUser.get(s.userId))).map(async (s: any) => {
      try {
        await webpush.sendNotification(s.subscription, body, { TTL: 60 * 60 * 24, urgency: 'high' });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await db.collection('push_subscriptions').doc(s.id).delete().catch(() => {});
        } else {
          console.warn('[PUSH] send failed:', err?.statusCode || err?.message);
        }
      }
    }));
  } catch (err) {
    console.warn('[PUSH] dispatch error:', err);
  }
}

app.get('/api/push/public-key', (_req, res) => { res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null }); });

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const session = (req as any).session as Session;
    const subscription = req.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'Invalid subscription' });
    const id = subId(subscription.endpoint);
    await db.collection('push_subscriptions').doc(id).set({ id, userId: session.userId, subscription, createdAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) { console.error('push subscribe failed', e); res.status(500).json({ error: 'Unable to save subscription' }); }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) await db.collection('push_subscriptions').doc(subId(endpoint)).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Unable to remove subscription' }); }
});

// Password login route (issues a PostgreSQL-backed server session)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { userId, passwordHash } = req.body;
    if (!userId || !passwordHash) {
      return res.status(400).json({ error: 'Missing userId or passwordHash' });
    }

    // Look up user in PostgreSQL
    const usersRef = db.collection('users');
    const querySnapshot = await usersRef.where('userId', '==', userId.trim()).get();

    if (querySnapshot.empty) {
      return res.status(401).json({ error: 'Invalid User ID or password.' });
    }

    const userDoc = querySnapshot.docs[0];
    const user = { id: userDoc.id, ...userDoc.data() } as any;

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been disabled. Please contact a Trustee.' });
    }

    if (user.passwordHash !== passwordHash) {
      return res.status(401).json({ error: 'Invalid User ID or password.' });
    }

    const lastLoginAt = new Date().toISOString();
    user.lastLoginAt = lastLoginAt;
    await db.collection('users').doc(user.id).update({
      lastLoginAt,
      updatedAt: lastLoginAt
    });

    // Generate Secure Server Session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await db.collection('sessions').doc(sessionToken).set({
      userId: user.userId,
      userDocId: user.id,
      role: user.role,
      name: user.name,
      createdAt: Date.now(),
    });

    res.json({
      success: true,
      user,
      sessionToken,
    });
  } catch (err: any) {
    console.error('Password login backend error:', err);
    res.status(500).json({ error: 'An unexpected internal error occurred.' });
  }
});

// WebAuthn Registration Options Generation
app.post('/api/webauthn/register-options', requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;
    const rpID = getRpID(req);

    // Fetch up-to-date user info
    const userSnap = await db.collection('users').doc(session.userDocId).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = { id: userSnap.id, ...userSnap.data()! } as any;

    // Generate challenge and register options
    const options = await generateRegistrationOptions({
      rpName: 'MVP Ledger Security Key',
      rpID,
      userID: Buffer.from(user.id),
      userName: user.userId,
      userDisplayName: user.name,
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Enforce on-device platform (TouchID, FaceID, Windows Hello, PIN)
        userVerification: 'required',
        residentKey: 'discouraged',
      },
    });

    // Save challenge temporarily (expires in 5 minutes)
    await db.collection('challenges').doc(`reg_challenge_${user.id}`).set({
      challenge: options.challenge,
      userId: user.id,
      expires: Date.now() + 5 * 60 * 1000,
    });

    res.json(options);
  } catch (err: any) {
    console.error('Registration options generation error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate registration challenge.' });
  }
});

// WebAuthn Registration Verification
app.post('/api/webauthn/register-verify', requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;
    const { body } = req;
    const rpID = getRpID(req);
    const origin = getOrigin(req);

    const challengeKey = `reg_challenge_${session.userDocId}`;
    const challengeDoc = await db.collection('challenges').doc(challengeKey).get();

    if (!challengeDoc.exists) {
      return res.status(400).json({ error: 'Registration challenge expired or missing. Please restart the registration.' });
    }

    const storedChallenge = challengeDoc.data()!;
    if (Date.now() > storedChallenge.expires) {
      await db.collection('challenges').doc(challengeKey).delete();
      return res.status(400).json({ error: 'Registration challenge expired or missing. Please restart the registration.' });
    }

    const expectedChallenge = storedChallenge.challenge;
    await db.collection('challenges').doc(challengeKey).delete(); // One-time use

    // ---- SANDBOX SIMULATION FALLBACK ----
    if (body && body.isSimulated) {
      if (body.challenge !== expectedChallenge) {
        return res.status(400).json({ error: 'Cryptographic challenge mismatch in biometric simulation.' });
      }

      await db.collection('users').doc(session.userDocId).update({
        biometricEnabled: true,
        biometricCredentialId: `simulated_${crypto.randomUUID()}`,
        biometricPublicKey: `simulated_pubkey_${crypto.randomBytes(16).toString('hex')}`,
        biometricCounter: 0,
        isSimulatedCredential: true,
        updatedAt: new Date().toISOString(),
      });

      console.log(`[BIOMETRIC SIMULATOR] Successfully registered Simulated Biometric credential for user ${session.userId}`);
      return res.json({ success: true, isSimulated: true });
    }

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential } = verification.registrationInfo;
      const { id: credentialID, publicKey: credentialPublicKey, counter } = credential;

      // Persist safe credential metadata to PostgreSQL
      const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64url');

      await db.collection('users').doc(session.userDocId).update({
        biometricEnabled: true,
        biometricCredentialId: credentialID,
        biometricPublicKey: publicKeyBase64,
        biometricCounter: counter,
        isSimulatedCredential: true,
        updatedAt: new Date().toISOString(),
      });

      console.log(`Successfully registered FIDO2 credential for user ${session.userId}`);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'FIDO2 biometric registration verification failed.' });
    }
  } catch (err: any) {
    console.error('Registration verification error:', err);
    res.status(500).json({ error: err.message || 'Credential verification failed.' });
  }
});

// WebAuthn Authentication Options Generation (Pre-login)
app.post('/api/webauthn/login-options', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'Missing User ID.' });
    }

    const rpID = getRpID(req);

    // Look up user to find registered biometric credential
    const usersRef = db.collection('users');
    const querySnapshot = await usersRef.where('userId', '==', userId.trim()).get();

    if (querySnapshot.empty) {
      return res.status(404).json({ error: 'User does not exist or has no registered biometric profile.' });
    }

    const userDoc = querySnapshot.docs[0];
    const user = { id: userDoc.id, ...userDoc.data() } as any;

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This profile is disabled.' });
    }

    if (!user.biometricEnabled || !user.biometricCredentialId) {
      return res.status(400).json({ error: 'Biometric login is not enrolled for this user.' });
    }

    // Generate WebAuthn Authentication Options
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [
        {
          id: user.biometricCredentialId,
        },
      ],
      userVerification: 'required',
    });

    // Save authentication challenge temporarily (expires in 5 minutes)
    await db.collection('challenges').doc(`auth_challenge_${user.id}`).set({
      challenge: options.challenge,
      userId: user.id,
      expires: Date.now() + 5 * 60 * 1000,
    });

    res.json(options);
  } catch (err: any) {
    console.error('Authentication options generation error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate sign-in challenge.' });
  }
});

// WebAuthn Authentication Verification (Completed login)
app.post('/api/webauthn/login-verify', async (req, res) => {
  try {
    const { userId, body } = req.body;
    if (!userId || !body) {
      return res.status(400).json({ error: 'Missing userId or credential payload.' });
    }

    const rpID = getRpID(req);
    const origin = getOrigin(req);

    // Look up user
    const usersRef = db.collection('users');
    const querySnapshot = await usersRef.where('userId', '==', userId.trim()).get();

    if (querySnapshot.empty) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userDoc = querySnapshot.docs[0];
    const user = { id: userDoc.id, ...userDoc.data() } as any;

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account disabled.' });
    }

    const challengeKey = `auth_challenge_${user.id}`;
    const challengeDoc = await db.collection('challenges').doc(challengeKey).get();

    if (!challengeDoc.exists) {
      return res.status(400).json({ error: 'Login challenge expired. Please try again.' });
    }

    const storedChallenge = challengeDoc.data()!;
    if (Date.now() > storedChallenge.expires) {
      await db.collection('challenges').doc(challengeKey).delete();
      return res.status(400).json({ error: 'Login challenge expired. Please try again.' });
    }

    const expectedChallenge = storedChallenge.challenge;
    await db.collection('challenges').doc(challengeKey).delete(); // One-time use

    // ---- SANDBOX SIMULATION FALLBACK ----
    if (body && body.isSimulated) {
      // The challenge is handed out by the public login-options route, so it proves nothing on
      // its own. Only accounts enrolled through the simulator may use this path; otherwise anyone
      // could skip the real passkey check for an account with a genuine credential.
      if (user.isSimulatedCredential !== true) {
        return res.status(400).json({ error: 'Simulated biometric login is not allowed for this account.' });
      }
      if (body.challenge !== expectedChallenge) {
        return res.status(400).json({ error: 'Cryptographic challenge mismatch in biometric login simulation.' });
      }

      const lastLoginAt = new Date().toISOString();
      user.lastLoginAt = lastLoginAt;
      await db.collection('users').doc(user.id).update({
        lastLoginAt,
        updatedAt: lastLoginAt
      });

      // Generate Secure Server Session
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await db.collection('sessions').doc(sessionToken).set({
        userId: user.userId,
        userDocId: user.id,
        role: user.role,
        name: user.name,
        createdAt: Date.now(),
      });

      console.log(`[BIOMETRIC SIMULATOR] Successfully verified Simulated Biometric login for user ${user.userId}`);
      return res.json({
        success: true,
        user,
        sessionToken,
        isSimulated: true,
      });
    }

    if (!user.biometricCredentialId || !user.biometricPublicKey) {
      return res.status(400).json({ error: 'No enrolled biometric credentials found.' });
    }

    // Decode public key from base64url back to Buffer
    const publicKeyBuffer = Buffer.from(user.biometricPublicKey, 'base64url');

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: user.biometricCredentialId,
        publicKey: publicKeyBuffer,
        counter: user.biometricCounter || 0,
      },
      requireUserVerification: true,
    });

    if (verification.verified && verification.authenticationInfo) {
      const { authenticationInfo } = verification;
      const newCounter = authenticationInfo.newCounter;

      const lastLoginAt = new Date().toISOString();
      user.lastLoginAt = lastLoginAt;

      // Update counter in database to prevent replay attacks
      await db.collection('users').doc(user.id).update({
        biometricCounter: newCounter,
        lastLoginAt,
        updatedAt: lastLoginAt,
      });

      // Generate Secure Server Session
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await db.collection('sessions').doc(sessionToken).set({
        userId: user.userId,
        userDocId: user.id,
        role: user.role,
        name: user.name,
        createdAt: Date.now(),
      });

      console.log(`Successfully verified FIDO2 biometric login for user ${user.userId}`);
      res.json({
        success: true,
        user,
        sessionToken,
      });
    } else {
      res.status(400).json({ error: 'FIDO2 cryptographic verification failed.' });
    }
  } catch (err: any) {
    console.error('Authentication verification error:', err);
    res.status(500).json({ error: err.message || 'Biometric authentication verification failed.' });
  }
});

// Revoke Biometric Passkey endpoint
app.post('/api/webauthn/revoke', requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;
    
    // Unset biometric fields in PostgreSQL
    await db.collection('users').doc(session.userDocId).update({
      biometricEnabled: false,
      biometricCredentialId: FieldValue.delete(),
      biometricPublicKey: FieldValue.delete(),
      biometricCounter: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });

    console.log(`Revoked WebAuthn credential for user doc id: ${session.userDocId}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Revocation error:', err);
    res.status(500).json({ error: err.message || 'Failed to revoke credential.' });
  }
});

// ==========================================
// GOOGLE SHEETS LIVE LEDGER SYNC ENDPOINT
// ==========================================
// Google Sheets access uses a server-side service account. Never accept OAuth tokens
// or spreadsheet IDs from the browser: every user reads the same configured sheet.
let googleTokenCache: { token: string; expiresAt: number } | null = null;
function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function getGoogleSheetsAccessToken(): Promise<string> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('Google Sheets server credentials are missing. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.');
  if (googleTokenCache && Date.now() < googleTokenCache.expiresAt - 60_000) return googleTokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(privateKey))}`;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const tokenData: any = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error('[GOOGLE SHEETS TOKEN ERROR]', tokenResponse.status, tokenData.error || tokenData.error_description || 'Token request failed');
    throw new Error('Could not authenticate the Google Sheets service account. Check its credentials and API setup.');
  }
  googleTokenCache = { token: tokenData.access_token, expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000 };
  return googleTokenCache.token;
}
function getConfiguredSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  if (!id) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not configured on the server.');
  return id;
}
async function googleSheetsFetch(url: string, init: RequestInit = {}) {
  const token = await getGoogleSheetsAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!response.ok) {
    const body: any = await response.json().catch(() => ({}));
    const message = body?.error?.message || `Google Sheets request failed (${response.status})`;
    const error: any = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response;
}
async function requireCurrentAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = (req as any).session as Session;
  try {
    const userDoc = await db.collection('users').doc(session.userDocId).get();
    const user = userDoc.data();
    if (!userDoc.exists || user?.status !== 'active') return res.status(403).json({ error: 'Active account required.' });
    if (!['Admin', 'Super Admin'].includes(String(user?.role))) return res.status(403).json({ error: 'Only Admin or Super Admin can update the shared Google Sheet.' });
    next();
  } catch (error) {
    console.error('[SHEETS ADMIN CHECK ERROR]', error);
    return res.status(500).json({ error: 'Unable to verify administrator permissions.' });
  }
}

// Any authenticated app user can read the shared sheet through this backend proxy.
app.get('/api/sheets/config', requireAuth, (_req, res) => {
  try {
    const spreadsheetId = getConfiguredSpreadsheetId();
    res.json({ configured: true, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  } catch {
    res.json({ configured: false, spreadsheetUrl: null });
  }
});
// ---- Ledger tab helpers (shared by manual sync, "Create Sheet" and auto-sync) ----
const LEDGER_TAB = 'Ledger';
const LEDGER_HEADERS = ['Record ID', 'Transaction Date', 'Nature', 'Money Sender', 'Money Receiver', 'Payment Method', 'Amount (₹)', 'Purpose', 'Notes', 'Created By', 'Status', 'Updated At'];
const sheetsBase = (spreadsheetId: string) => `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
const ledgerRange = (a1: string) => encodeURIComponent(`'${LEDGER_TAB}'!${a1}`);

async function ledgerTabExists(spreadsheetId: string): Promise<boolean> {
  const response = await googleSheetsFetch(`${sheetsBase(spreadsheetId)}?fields=sheets.properties.title`);
  const data: any = await response.json();
  return (data.sheets || []).some((s: any) => s?.properties?.title === LEDGER_TAB);
}
async function ensureLedgerTab(spreadsheetId: string): Promise<boolean> {
  if (await ledgerTabExists(spreadsheetId)) return false;
  await googleSheetsFetch(`${sheetsBase(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LEDGER_TAB, gridProperties: { frozenRowCount: 1 } } } }] }),
  });
  return true;
}
async function writeLedgerToSheet(spreadsheetId: string) {
  const result = await db.collection('records').get();
  const records = result.docs.map((doc: any) => doc.data()).filter((record: any) => record.status !== 'deleted');
  const rows = records.map((r: any) => [
    r.id || '', r.transactionDate || '', r.transactionNature || '', r.moneySender || '',
    r.moneyReceiver || '', r.transactionType || '', Number(r.amount) || 0, r.purpose || '',
    r.notes || '', r.createdBy || '', r.status || 'active', r.updatedAt || new Date().toISOString(),
  ]);
  const values = [LEDGER_HEADERS, ...rows];
  // RAW (not USER_ENTERED): record text is user-supplied, so it must never be evaluated as a formula.
  await googleSheetsFetch(`${sheetsBase(spreadsheetId)}/values/${ledgerRange('A1:L5000')}:clear`, { method: 'POST', body: JSON.stringify({}) });
  const writeRange = `A1:L${values.length}`;
  const response = await googleSheetsFetch(`${sheetsBase(spreadsheetId)}/values/${ledgerRange(writeRange)}?valueInputOption=RAW`, {
    method: 'PUT', body: JSON.stringify({ range: `'${LEDGER_TAB}'!${writeRange}`, majorDimension: 'ROWS', values }),
  });
  const data: any = await response.json();
  return { updatedRows: data.updatedRows || values.length, updatedCells: data.updatedCells || values.length * LEDGER_HEADERS.length };
}
function sheetsErrorStatus(error: any) {
  return error.status === 403 ? 403 : error.status === 404 ? 404 : error.message?.includes('not configured') || error.message?.includes('credentials are missing') ? 503 : 502;
}

// Auto-sync: any add / edit / delete of a ledger record refreshes the Ledger tab.
// Debounced and serialized so bursts of changes produce one write. It only runs once the
// Ledger tab exists (created via the "Create Sheet" button) and never blocks or fails the user's request.
let autoSyncTimer: NodeJS.Timeout | null = null;
let autoSyncRunning = false;
let autoSyncPending = false;
async function runAutoSync() {
  if (autoSyncRunning) { autoSyncPending = true; return; }
  autoSyncRunning = true;
  try {
    const spreadsheetId = getConfiguredSpreadsheetId();
    if (await ledgerTabExists(spreadsheetId)) await writeLedgerToSheet(spreadsheetId);
  } catch (error: any) {
    console.error('[GOOGLE SHEETS AUTO-SYNC ERROR]', error.status || '', error.message || error);
  } finally {
    autoSyncRunning = false;
    if (autoSyncPending) { autoSyncPending = false; scheduleSheetsAutoSync(); }
  }
}
function scheduleSheetsAutoSync() {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => { autoSyncTimer = null; void runAutoSync(); }, 1500);
}

app.get('/api/sheets/values', requireAuth, async (_req, res) => {
  try {
    const spreadsheetId = getConfiguredSpreadsheetId();
    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    if (!(await ledgerTabExists(spreadsheetId))) {
      return res.json({ success: true, spreadsheetUrl, range: '', values: [], tabExists: false, fetchedAt: new Date().toISOString() });
    }
    const response = await googleSheetsFetch(`${sheetsBase(spreadsheetId)}/values/${ledgerRange('A1:L5000')}`);
    const data: any = await response.json();
    res.json({ success: true, spreadsheetUrl, range: data.range || `${LEDGER_TAB}!A1:L5000`, values: data.values || [], tabExists: true, fetchedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('[GOOGLE SHEETS READ ERROR]', error.status || '', error.message || error);
    const status = error.status === 404 ? 404 : error.status === 403 ? 403 : 502;
    res.status(status).json({ error: error.message || 'Unable to read the shared Google Sheet. Check the sheet ID and service account access.' });
  }
});

// Only admins can overwrite the shared sheet. The server sources rows from the
// authenticated app's database instead of trusting record data sent by a browser.
app.post('/api/sheets/sync', requireAuth, requireCurrentAdmin, async (_req, res) => {
  try {
    const spreadsheetId = getConfiguredSpreadsheetId();
    await ensureLedgerTab(spreadsheetId);
    const written = await writeLedgerToSheet(spreadsheetId);
    res.json({ success: true, ...written, syncedAt: new Date().toISOString(), spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  } catch (error: any) {
    console.error('[GOOGLE SHEETS SYNC ERROR]', error.status || '', error.message || error);
    res.status(sheetsErrorStatus(error)).json({ error: error.message || 'Server failed to sync with Google Sheets.' });
  }
});

// "Create Sheet": creates the "Ledger" tab in the configured spreadsheet (if missing) and fills it
// with the current records. After this, add / edit / delete of records keep it in sync automatically.
app.post('/api/sheets/create', requireAuth, requireCurrentAdmin, async (_req, res) => {
  try {
    const spreadsheetId = getConfiguredSpreadsheetId();
    const created = await ensureLedgerTab(spreadsheetId);
    const written = await writeLedgerToSheet(spreadsheetId);
    res.json({ success: true, created, ...written, syncedAt: new Date().toISOString(), spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  } catch (error: any) {
    console.error('[GOOGLE SHEETS CREATE ERROR]', error.status || '', error.message || error);
    res.status(sheetsErrorStatus(error)).json({ error: error.message || 'Unable to create the Ledger sheet.' });
  }
});

// Catch-all 404 handler for /api routes to prevent requests falling through to Vite SPA index.html
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Express error middleware for /api routes
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path.startsWith('/api')) {
    console.error('[API SERVER ERROR]', err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  }
  next(err);
});

// ==========================================
// VITE DEV / PRODUCTION INTEGRATION
// ==========================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Must bind to 0.0.0.0 (not 'localhost') or hosts like Render cannot detect the open port.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FULLSTACK CORE] Server successfully listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
