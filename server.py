"""COMA: Python HTTP server, using only the standard library."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import sqlite3
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
DAY = 86_400_000


def now():
    return int(time.time() * 1000)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def public_user(user):
    return {**{k: user[k] for k in ('id', 'name', 'username')}, 'admin': bool(user['admin'])}


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def fail(status, message):
    raise HttpError(status, message)


def field(body, key, minimum, maximum):
    value = body.get(key)
    value = value.strip() if isinstance(value, str) else ''
    if not minimum <= len(value) <= maximum:
        fail(400, 'Check the information you entered.')
    return value


class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, data_dir=None, rate_limits=True, max_users=None):
        self.lock = threading.RLock()
        self.streams = {}
        self.limits = {}
        self.rate_limits = rate_limits
        self.max_users = int(max_users if max_users is not None else os.getenv('MAX_USERS', '100'))
        if self.max_users < 1:
            raise ValueError('MAX_USERS must be positive.')
        self.origin = os.getenv('PUBLIC_ORIGIN', '')
        self.secure = os.getenv('COOKIE_SECURE') == '1'
        if self.origin and not re.fullmatch(r'https?://[^/]+', self.origin):
            raise ValueError('PUBLIC_ORIGIN must be an origin without a path.')
        if self.origin.startswith('https://') and not self.secure:
            raise ValueError('Set COOKIE_SECURE=1 when using HTTPS.')
        directory = Path(data_dir or os.getenv('DATA_DIR') or ROOT / 'data').resolve()
        directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(directory / 'coma.sqlite', check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
        self.db.executescript((ROOT / 'schema.sql').read_text(encoding='utf-8'))
        self.last_cleanup = 0
        super().__init__(address, Handler)

    def run(self, sql, *args):
        return self.db.execute(sql, args)

    def one(self, sql, *args):
        row = self.run(sql, *args).fetchone()
        return dict(row) if row else None

    def all(self, sql, *args):
        return [dict(row) for row in self.run(sql, *args).fetchall()]

    def rate(self, key, limit, window=60_000):
        timestamp = now()
        if timestamp - self.last_cleanup > 60_000:
            self.limits = {k: v for k, v in self.limits.items() if v[1] > timestamp}
            self.run('DELETE FROM sessions WHERE expires_at < ?', timestamp)
            self.last_cleanup = timestamp
        if not self.rate_limits:
            return
        count, until = self.limits.get(key, (0, 0))
        if until <= timestamp:
            count, until = 0, timestamp + window
        self.limits[key] = (count + 1, until)
        if count >= limit:
            fail(429, 'Please slow down. Try again later.')

    def blocked(self, a, b):
        return bool(self.one('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a))

    def emit(self, *users):
        for user in set(users):
            for stream in self.streams.get(user, []):
                try:
                    stream.put_nowait(True)
                except queue.Full:
                    pass  # One pending sync already covers all changes.

    def invite(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            fail(400, 'This invitation is invalid.')
        invitation = self.one('SELECT * FROM invitations WHERE token_hash=? AND revoked=0 AND used_by IS NULL AND expires_at>?', digest(token), now())
        if not invitation:
            fail(410, 'This invitation has been used, revoked, or expired. Ask for a new link.')
        return invitation

    def accept(self, token, user):
        invitation = self.invite(token)
        creator = invitation['creator_id']
        if creator == user['id']:
            fail(400, 'This is your own invitation.')
        if self.blocked(creator, user['id']):
            fail(403, 'This contact is unavailable.')
        a, b = sorted((creator, user['id']))
        self.run('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)', str(uuid.uuid4()), a, b, now())
        self.run('UPDATE invitations SET used_by=? WHERE id=?', user['id'], invitation['id'])
        return self.one('SELECT id,a,b FROM conversations WHERE a=? AND b=?', a, b)


class Handler(BaseHTTPRequestHandler):
    server_version = 'COMA/Python'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        pass

    def headers_out(self, status, content_type, length=None):
        self.send_response(status)
        headers = {
            'Content-Type': content_type, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            **self.extra_headers,
        }
        if self.server.secure:
            headers['Strict-Transport-Security'] = 'max-age=31536000'
        if length is not None:
            headers['Content-Length'] = str(length)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()

    def json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.headers_out(status, 'application/json; charset=utf-8', len(data))
        if self.command != 'HEAD':
            self.wfile.write(data)

    def body(self):
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            fail(415, 'Send JSON.')
        if self.headers.get('Transfer-Encoding'):
            fail(400, 'Use Content-Length.')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            fail(400, 'Invalid data.')
        if length < 0 or length > 20000:
            fail(413, 'This request is too large.')
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            fail(400, 'Invalid data.')
        if not isinstance(value, dict):
            fail(400, 'Invalid data.')
        return value

    def session(self, user):
        raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.server.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(raw), user['id'], csrf, now() + 7 * DAY)
        self.cookie(raw, 604800)
        return {'user': public_user(user), 'csrf': csrf}

    def cookie(self, raw, age):
        self.extra_headers['Set-Cookie'] = f'coma_session={raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}' + ('; Secure' if self.server.secure else '')

    def handle_request(self):
        self.extra_headers = {}
        try:
            url = urlsplit(self.path)
            if url.path.startswith('/api/'):
                mutating = self.command not in ('GET', 'HEAD')
                origin = self.server.origin or 'http://' + self.headers.get('Host', '')
                if mutating and (self.headers.get('Origin') != origin or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
                    fail(403, 'This request did not come from COMA.')
                body = self.body() if mutating else {}
                with self.server.lock:
                    result = self.api(url, body, mutating)
                if isinstance(result, queue.Queue):
                    self.events(result)
                else:
                    value, status = result
                    self.json(value, status)
                return
            if self.command not in ('GET', 'HEAD'):
                fail(405, 'Not allowed.')
            assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/styles.css': ('styles.css', 'text/css'), '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
            if url.path not in assets:
                fail(404, 'Not found.')
            filename, mime = assets[url.path]
            data = (ROOT / 'public' / filename).read_bytes()
            self.headers_out(200, mime + '; charset=utf-8', len(data))
            if self.command != 'HEAD':
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except HttpError as error:
            self.json({'error': str(error)}, error.status)
        except Exception as error:
            print('COMA request failed:', type(error).__name__, flush=True)
            self.json({'error': 'Something went wrong. Please try again.'}, 500)

    do_GET = do_POST = do_PATCH = do_DELETE = do_HEAD = do_PUT = handle_request

    def api(self, url, body, mutating):
        app = self.server
        one, run, all_rows = app.one, app.run, app.all
        p, method = url.path, self.command
        ip = self.client_address[0]
        app.rate('global:' + ip, 600)
        raw = next((x.strip()[13:] for x in self.headers.get('Cookie', '').split(';') if x.strip().startswith('coma_session=')), '')
        self.session_hash = digest(raw) if raw else ''
        session = one('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', self.session_hash, now())
        user = one('SELECT * FROM users WHERE id=?', session['user_id']) if session else None
        self.extra_headers['X-Coma-User'] = user['id'] if user else ''
        if p == '/api/session' and method == 'GET':
            return {'user': public_user(user) if user else None, 'csrf': session['csrf'] if session else None, 'setup': not one('SELECT 1 FROM users LIMIT 1')}, 200
        if p == '/api/invitation' and method == 'POST':
            app.rate('preview:' + ip, 30)
            inv = app.invite(body.get('token'))
            return {'inviter': one('SELECT name FROM users WHERE id=?', inv['creator_id'])['name'], 'expiresAt': inv['expires_at']}, 200
        if p == '/api/register' and method == 'POST':
            app.rate('auth:' + ip, 15, 900000)
            name, username = field(body, 'name', 2, 40), field(body, 'username', 3, 24).lower()
            password = body.get('password')
            if not re.fullmatch('[a-z0-9_]{3,24}', username):
                fail(400, 'Use 3–24 letters, numbers, or underscores for your username.')
            if not isinstance(password, str) or not 12 <= len(password) <= 128:
                fail(400, 'Use a password of 12 to 128 characters.')
            salt = secrets.token_hex(16)
            key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
            run('BEGIN IMMEDIATE')
            try:
                count = one('SELECT count(*) n FROM users')['n']
                if count >= app.max_users:
                    fail(403, 'This test group is full.')
                if count and not body.get('invite'):
                    fail(403, 'You need an invitation to join.')
                if count:
                    app.invite(body['invite'])
                if one('SELECT 1 FROM users WHERE username=?', username):
                    fail(409, 'This username is already taken.')
                user = dict(id=str(uuid.uuid4()), name=name, username=username, admin=int(count == 0))
                run('INSERT INTO users VALUES(?,?,?,?,?,?)', user['id'], username, name, salt + ':' + key, user['admin'], now())
                c = app.accept(body['invite'], user) if count else None
                run('COMMIT')
            except Exception:
                run('ROLLBACK')
                raise
            result = self.session(user)
            if c:
                result['conversationId'] = c['id']
                app.emit(c['a'], c['b'])
            return result, 201
        if p == '/api/login' and method == 'POST':
            app.rate('auth:' + ip, 15, 900000)
            username = body.get('username', '')
            password = body.get('password', '')
            found = one('SELECT * FROM users WHERE username=?', username.lower().strip()[:24] if isinstance(username, str) else '')
            salt, key = found['password'].split(':') if found else ('not-a-real-account-salt', '00' * 64)
            derived = hashlib.scrypt((password[:128] if isinstance(password, str) else '').encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
            if not hmac.compare_digest(bytes.fromhex(key), derived) or not found:
                fail(401, 'Incorrect username or password.')
            return self.session(found), 200
        if not user:
            fail(401, 'Sign in again to continue.')
        uid = user['id']
        if mutating and self.headers.get('X-CSRF-Token') != session['csrf']:
            fail(403, 'Your session has changed. Reload the page.')
        if p == '/api/logout' and method == 'POST':
            run('DELETE FROM sessions WHERE token_hash=?', self.session_hash)
            app.emit(uid)
            self.cookie('', 0)
            return {'ok': True}, 200
        if p == '/api/profile' and method == 'PATCH':
            run('UPDATE users SET name=? WHERE id=?', field(body, 'name', 2, 40), uid)
            for c in all_rows('SELECT a,b FROM conversations WHERE a=? OR b=?', uid, uid):
                app.emit(c['a'], c['b'])
            return {'user': public_user(one('SELECT * FROM users WHERE id=?', uid))}, 200
        if p == '/api/events' and method == 'GET':
            streams = app.streams.setdefault(uid, [])
            if len(streams) >= 8:
                fail(429, 'Too many open COMA windows.')
            stream = queue.Queue(maxsize=1)
            streams.append(stream)
            self.stream_user = uid
            return stream
        if p == '/api/invites' and method == 'GET':
            return {'invites': all_rows('SELECT id,label,created_at,expires_at,used_by,revoked FROM invitations WHERE creator_id=? ORDER BY created_at DESC LIMIT 50', uid)}, 200
        if p == '/api/invites' and method == 'POST':
            app.rate('invite:' + uid, 10, DAY)
            token, iid, timestamp = secrets.token_urlsafe(32), str(uuid.uuid4()), now()
            label = body.get('label', '')
            label = label.strip()[:60] if isinstance(label, str) else ''
            run('INSERT INTO invitations(id,token_hash,creator_id,label,created_at,expires_at) VALUES(?,?,?,?,?,?)', iid, digest(token), uid, label, timestamp, timestamp + 7 * DAY)
            return {'id': iid, 'token': token, 'expiresAt': timestamp + 7 * DAY}, 201
        match = re.fullmatch(r'/api/invites/([a-f0-9-]+)', p)
        if match and method == 'DELETE':
            if not run('UPDATE invitations SET revoked=1 WHERE id=? AND creator_id=? AND used_by IS NULL', match[1], uid).rowcount:
                fail(404, 'Invitation not found.')
            return {'ok': True}, 200
        if p == '/api/invites/accept' and method == 'POST':
            run('BEGIN IMMEDIATE')
            try:
                c = app.accept(body.get('token'), user)
                run('COMMIT')
            except Exception:
                run('ROLLBACK')
                raise
            app.emit(c['a'], c['b'])
            return {'conversationId': c['id']}, 200
        if p == '/api/conversations' and method == 'GET':
            rows = all_rows('''SELECT c.id,c.created_at,u.id peer_id,u.name,u.username,
                m.body last_body,m.created_at last_at,m.sender_id last_sender,
                (SELECT count(*) FROM messages x WHERE x.conversation_id=c.id AND x.sender_id<>? AND x.id>coalesce(r.last_id,0)) unread,
                EXISTS(SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=u.id) blocked_by_me,
                EXISTS(SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=u.id) OR (blocker_id=u.id AND blocked_id=?)) blocked
                FROM conversations c JOIN users u ON u.id=CASE WHEN c.a=? THEN c.b ELSE c.a END
                LEFT JOIN messages m ON m.id=(SELECT max(id) FROM messages WHERE conversation_id=c.id)
                LEFT JOIN reads r ON r.conversation_id=c.id AND r.user_id=?
                WHERE c.a=? OR c.b=? ORDER BY coalesce(m.created_at,c.created_at) DESC,c.id''', *([uid] * 8))
            return {'conversations': rows}, 200
        match = re.fullmatch(r'/api/conversations/([a-f0-9-]+)/(messages|read|block|report)', p)
        if match:
            cid, action = match.groups()
            c = one('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)', cid, uid, uid)
            if not c:
                fail(404, 'Conversation not found.')
            peer = c['b'] if c['a'] == uid else c['a']
            if action == 'messages' and method == 'GET':
                try:
                    before = int(parse_qs(url.query).get('before', ['9007199254740991'])[0])
                    if not 1 <= before <= 9007199254740991:
                        raise ValueError()
                except ValueError:
                    fail(400, 'Invalid pagination.')
                rows = all_rows('SELECT id,sender_id,client_id,body,created_at FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 101', cid, before)
                read = one('SELECT last_id FROM reads WHERE conversation_id=? AND user_id=?', cid, peer)
                return {'messages': list(reversed(rows[:100])), 'hasMore': len(rows) > 100, 'peerRead': read['last_id'] if read else 0}, 200
            if action == 'messages' and method == 'POST':
                content, client_id = field(body, 'body', 1, 4000), body.get('clientId')
                if not isinstance(client_id, str) or not re.fullmatch('[a-f0-9-]{36}', client_id):
                    fail(400, 'Invalid message identifier.')
                existing = one('SELECT * FROM messages WHERE sender_id=? AND client_id=?', uid, client_id)
                if existing:
                    if existing['conversation_id'] != cid or existing['body'] != content:
                        fail(409, 'This message identifier is already in use.')
                    return {'message': existing}, 200
                if app.blocked(uid, peer):
                    fail(403, 'You cannot send messages in this conversation.')
                app.rate('message:' + uid, 60)
                mid = run('INSERT INTO messages(conversation_id,sender_id,client_id,body,created_at) VALUES(?,?,?,?,?)', cid, uid, client_id, content, now()).lastrowid
                app.emit(uid, peer)
                return {'message': one('SELECT * FROM messages WHERE id=?', mid)}, 201
            if action == 'read' and method == 'POST':
                mid = body.get('lastId')
                if type(mid) is not int or not 1 <= mid <= 9007199254740991 or not one('SELECT 1 FROM messages WHERE id=? AND conversation_id=?', mid, cid):
                    fail(400, 'Message not found.')
                run('INSERT INTO reads VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_id=max(last_id,excluded.last_id)', cid, uid, mid)
                app.emit(uid, peer)
                return {'ok': True}, 200
            if action == 'block' and method == 'POST':
                if type(body.get('blocked')) is not bool:
                    fail(400, 'Invalid choice.')
                if body['blocked']:
                    run('INSERT OR IGNORE INTO blocks VALUES(?,?)', uid, peer)
                else:
                    run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?', uid, peer)
                app.emit(uid, peer)
                return {'ok': True}, 200
            if action == 'report' and method == 'POST':
                app.rate('report:' + uid, 5, DAY)
                run('INSERT INTO reports(id,reporter_id,reported_id,conversation_id,reason,created_at) VALUES(?,?,?,?,?,?)', str(uuid.uuid4()), uid, peer, cid, field(body, 'reason', 5, 1000), now())
                return {'ok': True}, 201
        if p == '/api/reports' and method == 'GET':
            if not user['admin']:
                fail(403, 'Only the administrator can view reports.')
            return {'reports': all_rows('SELECT r.*,a.username reporter,b.username reported FROM reports r JOIN users a ON a.id=r.reporter_id JOIN users b ON b.id=r.reported_id ORDER BY r.created_at DESC LIMIT 100')}, 200
        match = re.fullmatch(r'/api/reports/([a-f0-9-]+)', p)
        if match and method == 'PATCH':
            if not user['admin']:
                fail(403, 'Only the administrator can resolve reports.')
            if not run('UPDATE reports SET resolved=1 WHERE id=?', match[1]).rowcount:
                fail(404, 'Report not found.')
            return {'ok': True}, 200
        fail(404, 'Not found.')

    def events(self, stream):
        app = self.server
        try:
            self.extra_headers['X-Accel-Buffering'] = 'no'
            self.headers_out(200, 'text/event-stream')
            self.wfile.write(b'event: sync\ndata: {}\n\n')
            self.wfile.flush()
            while True:
                try:
                    stream.get(timeout=20)
                    data = b'event: sync\ndata: {}\n\n'
                except queue.Empty:
                    data = b': heartbeat\n\n'
                with app.lock:
                    if not app.one('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?', self.session_hash, now()):
                        break
                self.wfile.write(data)
                self.wfile.flush()
        except (OSError, ValueError, sqlite3.ProgrammingError):
            pass
        finally:
            with app.lock:
                streams = app.streams.get(self.stream_user, [])
                if stream in streams:
                    streams.remove(stream)
                if not streams:
                    app.streams.pop(self.stream_user, None)


def main():
    parser = argparse.ArgumentParser(description='Start COMA met Python.')
    parser.add_argument('--open', action='store_true', help='Open COMA in je browser')
    args = parser.parse_args()
    host, port = os.getenv('HOST', '127.0.0.1'), int(os.getenv('PORT', '4310'))
    try:
        app = App((host, port))
    except (OSError, ValueError) as error:
        parser.exit(1, f'COMA could not start: {error}\n')
    url = f'http://{"localhost" if host == "0.0.0.0" else host}:{app.server_port}'
    print(f'COMA is ready at {url}\nPress Ctrl+C to stop.', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.server_close()
        with app.lock:
            app.db.close()


if __name__ == '__main__':
    main()
