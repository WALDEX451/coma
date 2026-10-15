import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const DAY = 86400000;
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, admin: Boolean(u.admin) });
const textField = (body, key, min, max) => {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (value.length < min || value.length > max) fail(400, key === 'name' ? 'Use a name of 2 to 40 characters.' : 'Check the information you entered.');
  return value;
};
export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(root, 'data'));
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'coma.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec([
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);',
    'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);',
    'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, creator_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES users(id), b TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE(a,b), CHECK(a < b));',
    'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at INTEGER NOT NULL, UNIQUE(sender_id,client_id));',
    'CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);',
    'CREATE TABLE IF NOT EXISTS reads (conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id), last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id));',
    'CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL REFERENCES users(id), blocked_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id <> blocked_id));',
    'CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), reported_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);',
    'PRAGMA user_version = 1;'
  ].join('\n'));
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const maxUsers = options.maxUsers ?? Number(process.env.MAX_USERS ?? 100);
  if (!Number.isSafeInteger(maxUsers) || maxUsers < 1) throw new Error('MAX_USERS must be a positive integer.');
  const secure = options.secureCookies ?? process.env.COOKIE_SECURE === '1';
  const configuredOrigin = options.origin ?? process.env.PUBLIC_ORIGIN;
  if (configuredOrigin && !/^https?:\/\/[^/]+$/.test(configuredOrigin)) throw new Error('PUBLIC_ORIGIN must be an origin without a path or trailing slash.');
  if (configuredOrigin?.startsWith('https://') && !secure) throw new Error('Set COOKIE_SECURE=1 for an HTTPS origin.');
  const streams = new Map(), limits = new Map();
  const rate = (key, limit, window = 60000) => {
    if (options.rateLimits === false) return;
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + window }; limits.set(key, entry); }
    if (++entry.count > limit) fail(429, 'Please slow down. Try again later.');
  };
  const housekeeping = setInterval(() => {
    for (const [key, entry] of limits) if (entry.until < Date.now()) limits.delete(key);
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  }, 60000);
  housekeeping.unref();
  const blocked = (a,b) => Boolean(one('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a,b,b,a));
  const emit = (...ids) => {
    for (const id of new Set(ids)) for (const stream of streams.get(id) ?? []) {
      if (!stream.response.write('event: sync\ndata: {}\n\n')) stream.response.end();
    }
  };
  const endSessions = (userId, sessionHash) => {
    for (const stream of streams.get(userId) ?? []) if (stream.sessionHash === sessionHash) stream.response.end();
  };
  const conversation = (id, user) => {
    const c = one('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)', id, user.id,user.id);
    if (!c) fail(404, 'Conversation not found.');
    return { ...c, peer: c.a === user.id ? c.b : c.a };
  };
  const getInvite = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail(400, 'This invitation is invalid.');
    const inv = one('SELECT * FROM invitations WHERE token_hash=? AND revoked=0 AND used_by IS NULL AND expires_at>?', hash(value), Date.now());
    if (!inv) fail(410, 'This invitation has been used, revoked, or expired. Ask for a new link.');
    return inv;
  };
  const acceptInvite = (value, user) => {
    const inv = getInvite(value);
    if (inv.creator_id === user.id) fail(400, 'This is your own invitation. Share the link with someone else.');
    if (blocked(inv.creator_id, user.id)) fail(403, 'This contact is unavailable.');
    const [a,b] = [inv.creator_id, user.id].sort();
    run('INSERT OR IGNORE INTO conversations(id,a,b,created_at) VALUES(?,?,?,?)',randomUUID(),a,b,Date.now());
    run('UPDATE invitations SET used_by=? WHERE id=?', user.id,inv.id);
    return one('SELECT id,a,b FROM conversations WHERE a=? AND b=?', a,b);
  };
  const setSession = (res, user) => {
    const raw = token(), csrf = token();
    run('INSERT INTO sessions VALUES(?,?,?,?)',hash(raw),user.id,csrf,Date.now()+7*DAY);
    res.setHeader('Set-Cookie', 'coma_session='+raw+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'+(secure?'; Secure':''));
    return { user: publicUser(user), csrf };
  };
  const json = (res, value, status=200) => {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const bodyOf = async req => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) fail(415, 'Send JSON.');
    let length = 0, chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 20000) fail(413, 'This request is too large.'); chunks.push(chunk); }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch { fail(400, 'Invalid data.'); }
  };
  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('Cache-Control','no-store');
    if (secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const expectedOrigin = configuredOrigin ?? 'http://'+req.headers.host;
      const url = new URL(req.url, expectedOrigin);
      const p = url.pathname, method = req.method;
      if (p.startsWith('/api/')) {
        rate('global:'+req.socket.remoteAddress, 600);
        const mutating = !['GET','HEAD'].includes(method);
        if (mutating && (req.headers.origin !== expectedOrigin || req.headers['sec-fetch-site'] === 'cross-site')) fail(403, 'This request did not come from COMA.');
        const rawCookie = (req.headers.cookie ?? '').split(';').map(s=>s.trim()).find(s=>s.startsWith('coma_session='))?.slice(13);
        const sessionHash = rawCookie ? hash(rawCookie) : '';
        const session = sessionHash ? one('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', sessionHash,Date.now()) : null;
        const user = session ? one('SELECT * FROM users WHERE id=?',session.user_id) : null;
        res.setHeader('X-Coma-User',user?.id ?? '');
        const body = mutating ? await bodyOf(req) : {};
        if (p === '/api/session' && method === 'GET') return json(res,{ user:user?publicUser(user):null, csrf:session?.csrf??null, setup:!one('SELECT 1 FROM users LIMIT 1') });
        if (p === '/api/invitation' && method === 'POST') {
          rate('preview:'+req.socket.remoteAddress,30);
          const inv = getInvite(body.token);
          return json(res, { inviter: one('SELECT name FROM users WHERE id=?',inv.creator_id).name, expiresAt:inv.expires_at });
        }
        if (p === '/api/register' && method === 'POST') {
          rate('auth:'+req.socket.remoteAddress,15,15*60000);
          const name = textField(body,'name',2,40);
          const username = textField(body,'username',3,24).toLowerCase();
          if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400,'Use 3–24 letters, numbers, or underscores for your username.');
          if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400,'Use a password of 12 to 128 characters.');
          const salt = randomBytes(16).toString('hex');
          const key = await derive(body.password,salt,64,{N:16384,r:8,p:1});
          const newUser = {id:randomUUID(),name,username};
          let c;
          transaction(() => {
            const count = one('SELECT count(*) n FROM users').n;
            if (count >= maxUsers) fail(403,'This test group is full. Contact the administrator.');
            if (count && !body.invite) fail(403,'You need an invitation to join.');
            if (count) getInvite(body.invite);
            if (one('SELECT 1 FROM users WHERE username=?',username)) fail(409,'This username is already taken.');
            newUser.admin = count === 0 ? 1 : 0;
            run('INSERT INTO users VALUES(?,?,?,?,?,?)',newUser.id,username,name,salt+':'+key.toString('hex'),newUser.admin,Date.now());
            if (count) c = acceptInvite(body.invite,newUser);
          });
          const result = setSession(res,newUser);
          if (c) emit(c.a,c.b);
          return json(res,{...result,conversationId:c?.id},201);
        }
        if (p === '/api/login' && method === 'POST') {
          rate('auth:'+req.socket.remoteAddress,15,15*60000);
          const username = typeof body.username === 'string' ? body.username.toLowerCase().trim().slice(0,24) : '';
          const found = one('SELECT * FROM users WHERE username=?',username);
          const [salt,key] = found ? found.password.split(':') : ['not-a-real-account-salt','00'.repeat(64)];
          const password = typeof body.password === 'string' ? body.password.slice(0,128) : '';
          const derived = await derive(password,salt,64,{N:16384,r:8,p:1});
          if (!found || !timingSafeEqual(Buffer.from(key,'hex'),derived)) fail(401,'Incorrect username or password.');
          return json(res,setSession(res,found));
        }
        if (!user) fail(401,'Sign in again to continue.');
        if (mutating && req.headers['x-csrf-token'] !== session.csrf) fail(403,'Your session has changed. Reload the page.');
        if (p === '/api/logout' && method === 'POST') {
          run('DELETE FROM sessions WHERE token_hash=?',sessionHash); endSessions(user.id,sessionHash);
          res.setHeader('Set-Cookie','coma_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(secure?'; Secure':''));
          return json(res,{ok:true});
        }
        if (p === '/api/profile' && method === 'PATCH') {
          run('UPDATE users SET name=? WHERE id=?',textField(body,'name',2,40),user.id);
          const peers = all('SELECT a,b FROM conversations WHERE a=? OR b=?',user.id,user.id).flatMap(c=>[c.a,c.b]); emit(user.id,...peers);
          return json(res,{user:publicUser(one('SELECT * FROM users WHERE id=?',user.id))});
        }
        if (p === '/api/events' && method === 'GET') {
          if ((streams.get(user.id)?.size ?? 0) >= 8) fail(429,'Too many open COMA windows.');
          res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write('event: sync\ndata: {}\n\n');
          const stream = {response:res,sessionHash};
          if (!streams.has(user.id)) streams.set(user.id,new Set());
          streams.get(user.id).add(stream);
          const heartbeat = setInterval(() => { if (session.expires_at < Date.now()) return res.end(); res.write(': heartbeat\n\n'); },20000);
          res.on('close',()=>{clearInterval(heartbeat);streams.get(user.id)?.delete(stream);if(!streams.get(user.id)?.size)streams.delete(user.id);});
          return;
        }
        if (p === '/api/invites' && method === 'GET') return json(res,{invites:all('SELECT id,label,created_at,expires_at,used_by,revoked FROM invitations WHERE creator_id=? ORDER BY created_at DESC LIMIT 50',user.id)});
        if (p === '/api/invites' && method === 'POST') {
          rate('invite:'+user.id,10,DAY);
          const raw = token(), id = randomUUID(), now = Date.now();
          const label = typeof body.label === 'string' ? body.label.trim().slice(0,60) : '';
          run('INSERT INTO invitations(id,token_hash,creator_id,label,created_at,expires_at) VALUES(?,?,?,?,?,?)',id,hash(raw),user.id,label,now,now+7*DAY);
          return json(res,{id,token:raw,expiresAt:now+7*DAY},201);
        }
        const inviteId = p.match(/^\/api\/invites\/([a-f0-9-]+)$/)?.[1];
        if (inviteId && method === 'DELETE') {
          if (!run('UPDATE invitations SET revoked=1 WHERE id=? AND creator_id=? AND used_by IS NULL',inviteId,user.id).changes) fail(404,'Invitation not found.');
          return json(res,{ok:true});
        }
        if (p === '/api/invites/accept' && method === 'POST') {
          const c = transaction(()=>acceptInvite(body.token,user)); emit(c.a,c.b); return json(res,{conversationId:c.id});
        }
        if (p === '/api/conversations' && method === 'GET') {
          const sql = [
            'SELECT c.id,c.created_at,u.id peer_id,u.name,u.username,m.body last_body,m.created_at last_at,m.sender_id last_sender,',
            '(SELECT count(*) FROM messages x WHERE x.conversation_id=c.id AND x.sender_id<>? AND x.id>coalesce(r.last_id,0)) unread,',
            'EXISTS(SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=u.id) blocked_by_me,',
            'EXISTS(SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=u.id) OR (blocker_id=u.id AND blocked_id=?)) blocked',
            'FROM conversations c JOIN users u ON u.id=CASE WHEN c.a=? THEN c.b ELSE c.a END',
            'LEFT JOIN messages m ON m.id=(SELECT max(id) FROM messages WHERE conversation_id=c.id)',
            'LEFT JOIN reads r ON r.conversation_id=c.id AND r.user_id=?',
            'WHERE c.a=? OR c.b=? ORDER BY coalesce(m.created_at,c.created_at) DESC,c.id'
          ].join(' ');
          return json(res,{conversations:all(sql,user.id,user.id,user.id,user.id,user.id,user.id,user.id,user.id)});
        }
        const match = p.match(/^\/api\/conversations\/([a-f0-9-]+)\/(messages|read|block|report)$/);
        if (match) {
          const c = conversation(match[1],user), action = match[2];
          if (action === 'messages' && method === 'GET') {
            const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
            if (!Number.isSafeInteger(before) || before < 1) fail(400,'Invalid pagination.');
            const rows = all('SELECT id,sender_id,client_id,body,created_at FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 101',c.id,before);
            return json(res,{messages:rows.slice(0,100).reverse(),hasMore:rows.length>100,peerRead:one('SELECT last_id FROM reads WHERE conversation_id=? AND user_id=?',c.id,c.peer)?.last_id??0});
          }
          if (action === 'messages' && method === 'POST') {
            const content = textField(body,'body',1,4000);
            if (typeof body.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.clientId)) fail(400,'Invalid message identifier.');
            const existing = one('SELECT * FROM messages WHERE sender_id=? AND client_id=?',user.id,body.clientId);
            if (existing) {
              if (existing.conversation_id !== c.id || existing.body !== content) fail(409,'This message identifier is already in use.');
              return json(res,{message:existing});
            }
            if (blocked(user.id,c.peer)) fail(403,'You cannot send messages in this conversation.');
            rate('message:'+user.id,60);
            const result = run('INSERT INTO messages(conversation_id,sender_id,client_id,body,created_at) VALUES(?,?,?,?,?)',c.id,user.id,body.clientId,content,Date.now());
            const message = one('SELECT * FROM messages WHERE id=?',Number(result.lastInsertRowid)); emit(c.a,c.b);
            return json(res,{message},201);
          }
          if (action === 'read' && method === 'POST') {
            if (!Number.isSafeInteger(body.lastId) || !one('SELECT 1 FROM messages WHERE id=? AND conversation_id=?',body.lastId,c.id)) fail(400,'Message not found.');
            run('INSERT INTO reads VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_id=max(last_id,excluded.last_id)',c.id,user.id,body.lastId);
            emit(c.a,c.b); return json(res,{ok:true});
          }
          if (action === 'block' && method === 'POST') {
            if (typeof body.blocked !== 'boolean') fail(400,'Invalid choice.');
            if (body.blocked) run('INSERT OR IGNORE INTO blocks VALUES(?,?)',user.id,c.peer);
            else run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?',user.id,c.peer);
            emit(c.a,c.b); return json(res,{ok:true});
          }
          if (action === 'report' && method === 'POST') {
            rate('report:'+user.id,5,DAY);
            run('INSERT INTO reports(id,reporter_id,reported_id,conversation_id,reason,created_at) VALUES(?,?,?,?,?,?)',randomUUID(),user.id,c.peer,c.id,textField(body,'reason',5,1000),Date.now());
            return json(res,{ok:true},201);
          }
        }
        if (p === '/api/reports' && method === 'GET') {
          if (!user.admin) fail(403,'Only the administrator can view reports.');
          return json(res,{reports:all('SELECT r.*,a.username reporter,b.username reported FROM reports r JOIN users a ON a.id=r.reporter_id JOIN users b ON b.id=r.reported_id ORDER BY r.created_at DESC LIMIT 100')});
        }
        const reportId = p.match(/^\/api\/reports\/([a-f0-9-]+)$/)?.[1];
        if (reportId && method === 'PATCH') {
          if (!user.admin) fail(403,'Only the administrator can resolve reports.');
          if (!run('UPDATE reports SET resolved=1 WHERE id=?',reportId).changes) fail(404,'Report not found.');
          return json(res,{ok:true});
        }
        fail(404,'Not found.');
      }
      if (!['GET','HEAD'].includes(method)) fail(405,'Not allowed.');
      const assets = {'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'};
      if (!assets[p]) fail(404,'Not found.');
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
      const filename = assets[p], type = types[filename.slice(filename.lastIndexOf('.'))];
      const content = await readFile(join(root,'public',filename));
      res.writeHead(200,{'Content-Type':type}); res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!(error instanceof HttpError)) console.error('COMA request failed:', error.code ?? error.name);
      json(res,{error:error instanceof HttpError ? error.message : 'Something went wrong. Please try again.'},error.status??500);
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return {
    server, db,
    listen: (port=4310,host='127.0.0.1') => new Promise((resolve,reject)=> {
      server.once('error',reject); server.listen(port,host,()=>{server.off('error',reject);resolve(server.address());});
    }),
    close: async () => {
      clearInterval(housekeeping);
      for (const set of streams.values()) for(const s of set) s.response.end();
      await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}); db.close();
    }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp(), host = process.env.HOST ?? '127.0.0.1';
  const address = await app.listen(Number(process.env.PORT ?? 4310),host);
  console.log('COMA is ready at http://'+(host==='0.0.0.0'?'localhost':host)+':'+address.port);
  console.log('Accounts and messages are stored locally. Press Ctrl+C to stop.');
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);};
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
