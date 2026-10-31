/**
 * @file Accounts: users, sessions, notebooks, and who may open which.
 *
 * The sync engine knows rooms and replicas, not people. This module is the
 * relational side of a deployment: a small SQLite database (`accounts.db`)
 * that says who exists, who is signed in, which notebooks there are, and who
 * may read or write each one. The notes themselves stay in the per-room
 * operation logs; nothing here duplicates them.
 *
 * Tables (see `SCHEMA` for the constraints):
 *
 *   users        one row per account; `role` is 'admin' or 'user'
 *   sessions     one row per sign-in; only a hash of the cookie is stored
 *   notebooks    one row per shared notebook; `room` is the sync room
 *   memberships  (notebook, user) -> 'owner' | 'editor' | 'viewer'
 *   audit_log    who did what, kept after the actor is deleted
 *   settings     the server's own signing secret
 *
 * Integrity is the database's job wherever it can be: foreign keys cascade a
 * deleted user's sessions, notebooks and memberships; a trigger makes every
 * notebook's owner a member; two more refuse to remove the last active admin.
 * The JavaScript checks are for friendly messages, not for correctness.
 *
 * Sync requests authenticate with a *sync token* derived from the session,
 * `rvs1.<session id>.<hmac>`. It is checked on every request against the live
 * session, so signing out, disabling a user or removing a member takes effect
 * on the next sync, not when some token expires.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AuthError, ValidationError } from '#core/errors';
import { roomTokens } from '#server/tokens';

const scrypt = promisify(scryptCallback);

export const ROLES = Object.freeze(['admin', 'user']);
export const MEMBER_ROLES = Object.freeze(['owner', 'editor', 'viewer']);

const SCHEMA_VERSION = 1;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/i;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SYNC_PREFIX = 'rvs1';
// scrypt at N=2^14 costs ~40 ms and 16 MB: slow for a guesser, fine for a login.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };
const SEEN_RESOLUTION_MS = 60_000;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE
                        CHECK (length(username) BETWEEN 3 AND 32),
  display_name  TEXT    NOT NULL DEFAULT '' CHECK (length(display_name) <= 60),
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS notebooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT    NOT NULL UNIQUE,
  title      TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  owner_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  encrypted  INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notebooks_by_owner ON notebooks (owner_id);

CREATE TABLE IF NOT EXISTS memberships (
  notebook_id INTEGER NOT NULL REFERENCES notebooks (id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (notebook_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor    TEXT    NOT NULL,
  action   TEXT    NOT NULL,
  target   TEXT    NOT NULL DEFAULT '',
  detail   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log (at);

-- The owner is a member like anyone else, so an access check is one lookup.
CREATE TRIGGER IF NOT EXISTS notebook_owner_is_member
AFTER INSERT ON notebooks
BEGIN
  INSERT INTO memberships (notebook_id, user_id, role, added_at)
  VALUES (NEW.id, NEW.owner_id, 'owner', NEW.created_at);
END;

-- Someone must always be able to administer the server.
CREATE TRIGGER IF NOT EXISTS keep_an_admin_on_update
BEFORE UPDATE OF role, disabled ON users
WHEN OLD.role = 'admin' AND OLD.disabled = 0
 AND (NEW.role <> 'admin' OR NEW.disabled = 1)
 AND (SELECT count(*) FROM users WHERE role = 'admin' AND disabled = 0) = 1
BEGIN
  SELECT RAISE(ABORT, 'the last active admin cannot be demoted or disabled');
END;

CREATE TRIGGER IF NOT EXISTS keep_an_admin_on_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND OLD.disabled = 0
 AND (SELECT count(*) FROM users WHERE role = 'admin' AND disabled = 0) = 1
BEGIN
  SELECT RAISE(ABORT, 'the last active admin cannot be deleted');
END;

CREATE VIEW IF NOT EXISTS user_overview AS
SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at, u.last_login_at,
       (SELECT count(*) FROM notebooks n WHERE n.owner_id = u.id)  AS notebooks_owned,
       (SELECT count(*) FROM memberships m WHERE m.user_id = u.id) AS notebooks_joined,
       (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
FROM users u;

CREATE VIEW IF NOT EXISTS notebook_overview AS
SELECT n.id, n.room, n.title, n.encrypted, n.created_at, n.owner_id,
       o.username AS owner, count(m.user_id) AS members
FROM notebooks n
JOIN users o ON o.id = n.owner_id
LEFT JOIN memberships m ON m.notebook_id = n.id
GROUP BY n.id;
`;

/* ------------------------------------------------------------- passwords */

/** Hash a password as `scrypt$N$r$p$salt$hash`, so the cost can change later. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Check a password against a stored hash, in constant time. */
export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/* ------------------------------------------------------------ validation */

function checkUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new ValidationError('a username is 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  }
  return username;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ValidationError(`a password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  return password;
}

function checkTitle(title) {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (clean.length < 1 || clean.length > 80) throw new ValidationError('a notebook title is 1 to 80 characters');
  return clean;
}

function checkOneOf(value, allowed, what) {
  if (!allowed.includes(value)) throw new ValidationError(`unknown ${what}`, { [what]: value, known: allowed });
  return value;
}

/** SQLite constraint failures, translated into something a person can act on. */
function translate(err) {
  const message = String(err?.message ?? err);
  if (/UNIQUE constraint failed: users\.username/.test(message)) return new ValidationError('that username is taken');
  if (/last active admin/.test(message)) return new ValidationError(message.replace(/^.*?(the last)/, '$1'));
  if (/CHECK constraint failed/.test(message)) return new ValidationError('a value is out of range', { sqlite: message });
  return err;
}

/* ------------------------------------------------------------------ rows */

const toUser = (row) => row && {
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  disabled: row.disabled === 1,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at ?? null,
  ...(row.notebooks_owned !== undefined ? {
    notebooksOwned: row.notebooks_owned,
    notebooksJoined: row.notebooks_joined,
    lastSeenAt: row.last_seen_at ?? null,
  } : {}),
};

const toNotebook = (row) => row && {
  id: row.id,
  room: row.room,
  title: row.title,
  encrypted: row.encrypted === 1,
  createdAt: row.created_at,
  ownerId: row.owner_id,
  owner: row.owner,
  members: row.members,
  ...(row.my_role ? { role: row.my_role } : {}),
};

/* ----------------------------------------------------------------- store */

export class AccountStore {
  #db;
  #q;
  #secret;
  #sessionMs;
  #now;

  /**
   * @param {object} [opts]
   * @param {string} [opts.path] database file; ':memory:' for tests
   * @param {number} [opts.sessionDays] how long a sign-in lasts
   * @param {() => number} [opts.now] clock, for tests
   */
  constructor({ path = ':memory:', sessionDays = 7, now = Date.now } = {}) {
    this.#db = new DatabaseSync(path);
    this.#sessionMs = sessionDays * 86_400_000;
    this.#now = now;

    this.#db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.#q = this.#prepare();

    let secret = this.#q.setting.get('sync_secret')?.value;
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      this.#q.putSetting.run('sync_secret', secret);
    }
    this.#secret = secret;
  }

  #prepare() {
    const db = this.#db;
    const s = (sql) => db.prepare(sql);
    return {
      setting: s('SELECT value FROM settings WHERE key = ?'),
      putSetting: s('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),

      insertUser: s(`INSERT INTO users (username, display_name, password_hash, role, created_at)
                     VALUES (?, ?, ?, ?, ?)`),
      userById: s('SELECT * FROM users WHERE id = ?'),
      userByName: s('SELECT * FROM users WHERE username = ?'),
      userOverview: s('SELECT * FROM user_overview ORDER BY username COLLATE NOCASE'),
      userOverviewById: s('SELECT * FROM user_overview WHERE id = ?'),
      setRole: s('UPDATE users SET role = ? WHERE id = ?'),
      setDisabled: s('UPDATE users SET disabled = ? WHERE id = ?'),
      setDisplayName: s('UPDATE users SET display_name = ? WHERE id = ?'),
      setPassword: s('UPDATE users SET password_hash = ? WHERE id = ?'),
      setLastLogin: s('UPDATE users SET last_login_at = ? WHERE id = ?'),
      deleteUser: s('DELETE FROM users WHERE id = ?'),

      insertSession: s(`INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      sessionByHash: s(`SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
                        FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ?`),
      sessionById: s(`SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
                      FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.id = ?`),
      touchSession: s('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
      deleteSession: s('DELETE FROM sessions WHERE id = ?'),
      deleteSessionsOf: s('DELETE FROM sessions WHERE user_id = ?'),
      purgeSessions: s('DELETE FROM sessions WHERE expires_at <= ?'),

      insertNotebook: s('INSERT INTO notebooks (room, title, owner_id, encrypted, created_at) VALUES (?, ?, ?, ?, ?)'),
      notebookById: s('SELECT * FROM notebook_overview WHERE id = ?'),
      notebookByRoom: s('SELECT * FROM notebook_overview WHERE room = ?'),
      notebooksOf: s(`SELECT v.*, m.role AS my_role
                      FROM memberships m JOIN notebook_overview v ON v.id = m.notebook_id
                      WHERE m.user_id = ?
                      ORDER BY v.created_at, v.id`),
      allNotebooks: s('SELECT * FROM notebook_overview ORDER BY created_at, id'),
      ownedRooms: s('SELECT room FROM notebooks WHERE owner_id = ?'),
      renameNotebook: s('UPDATE notebooks SET title = ? WHERE id = ?'),
      deleteNotebook: s('DELETE FROM notebooks WHERE id = ?'),

      access: s(`SELECT m.role FROM notebooks n
                 JOIN memberships m ON m.notebook_id = n.id
                 WHERE n.room = ? AND m.user_id = ?`),
      members: s(`SELECT u.id, u.username, u.display_name, m.role, m.added_at
                  FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.notebook_id = ?
                  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username COLLATE NOCASE`),
      membership: s('SELECT role FROM memberships WHERE notebook_id = ? AND user_id = ?'),
      upsertMember: s(`INSERT INTO memberships (notebook_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT (notebook_id, user_id) DO UPDATE SET role = excluded.role`),
      deleteMember: s('DELETE FROM memberships WHERE notebook_id = ? AND user_id = ?'),

      audit: s('INSERT INTO audit_log (at, actor_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)'),
      recentAudit: s('SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?'),

      counts: s(`SELECT
                   (SELECT count(*) FROM users)                                   AS users,
                   (SELECT count(*) FROM users WHERE role = 'admin')              AS admins,
                   (SELECT count(*) FROM users WHERE disabled = 1)                AS disabled,
                   (SELECT count(*) FROM notebooks)                               AS notebooks,
                   (SELECT count(*) FROM notebooks WHERE encrypted = 1)           AS encrypted,
                   (SELECT count(*) FROM memberships)                             AS memberships,
                   (SELECT count(*) FROM sessions WHERE expires_at > ?)           AS sessions,
                   (SELECT count(*) FROM audit_log)                               AS events`),
      objects: s(`SELECT type, name, tbl_name AS "table", sql FROM sqlite_schema
                  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                  ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`),
      pages: s('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()'),
    };
  }

  close() { this.#db.close(); }

  /** Run `fn` in one transaction: all of it lands, or none of it. */
  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw translate(err);
    }
  }

  #record(actor, action, target = '', detail = '') {
    this.#q.audit.run(this.#now(), actor?.id ?? null, actor?.username ?? 'system', action, String(target), String(detail));
  }

  /* --------------------------------------------------------------- users */

  /**
   * @param {object} fields
   * @param {string} fields.username
   * @param {string} fields.password
   * @param {string} [fields.displayName]
   * @param {'admin'|'user'} [fields.role]
   * @param {object} [actor] who is doing it, for the audit log; omitted means self sign-up
   */
  async createUser({ username, password, displayName = '', role = 'user' }, actor) {
    checkUsername(username);
    checkPassword(password);
    checkOneOf(role, ROLES, 'role');
    const name = String(displayName ?? '').trim().slice(0, 60);
    const hash = await hashPassword(password);
    return this.#tx(() => {
      const { lastInsertRowid } = this.#q.insertUser.run(username, name, hash, role, this.#now());
      const user = toUser(this.#q.userById.get(lastInsertRowid));
      this.#record(actor ?? user, actor ? 'user.create' : 'user.signup', user.username, role);
      return user;
    });
  }

  /** @returns {object|null} */
  user(id) { return toUser(this.#q.userOverviewById.get(id)) ?? null; }

  /** @returns {object|null} */
  userByName(username) {
    const row = typeof username === 'string' ? this.#q.userByName.get(username) : undefined;
    return row ? this.user(row.id) : null;
  }

  users() { return this.#q.userOverview.all().map(toUser); }

  /**
   * Change a user's role, status or display name.
   * @param {number} id
   * @param {{ role?: string, disabled?: boolean, displayName?: string }} changes
   */
  updateUser(id, { role, disabled, displayName }, actor) {
    const before = this.#q.userById.get(id);
    if (!before) throw new ValidationError('no such user', { id });
    return this.#tx(() => {
      if (role !== undefined && role !== before.role) {
        this.#q.setRole.run(checkOneOf(role, ROLES, 'role'), id);
        this.#record(actor, 'user.role', before.username, role);
      }
      if (disabled !== undefined && Boolean(disabled) !== (before.disabled === 1)) {
        this.#q.setDisabled.run(disabled ? 1 : 0, id);
        // A disabled account is signed out everywhere, at once.
        if (disabled) this.#q.deleteSessionsOf.run(id);
        this.#record(actor, disabled ? 'user.disable' : 'user.enable', before.username);
      }
      if (displayName !== undefined) {
        this.#q.setDisplayName.run(String(displayName).trim().slice(0, 60), id);
      }
      return this.user(id);
    });
  }

  /** Set a new password and sign the user out of every other session. */
  async setPassword(id, password, actor, { keepSession } = {}) {
    checkPassword(password);
    const target = this.#q.userById.get(id);
    if (!target) throw new ValidationError('no such user', { id });
    const hash = await hashPassword(password);
    this.#tx(() => {
      this.#q.setPassword.run(hash, id);
      this.#db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(id, keepSession ?? null);
      this.#record(actor, actor?.id === id ? 'user.password' : 'user.password-reset', target.username);
    });
  }

  /** Change your own password, given the current one. */
  async changePassword(user, current, next, sessionId) {
    const row = this.#q.userById.get(user.id);
    if (!row || !(await verifyPassword(String(current ?? ''), row.password_hash))) {
      throw new ValidationError('the current password is wrong');
    }
    await this.setPassword(user.id, next, user, { keepSession: sessionId });
  }

  /**
   * Delete a user. Their sessions, memberships and the notebooks they own go
   * with them (foreign keys cascade); the caller gets the owned notebooks'
   * rooms back so it can drop their operation logs too.
   * @returns {string[]} rooms that no longer have a notebook
   */
  deleteUser(id, actor) {
    const target = this.#q.userById.get(id);
    if (!target) throw new ValidationError('no such user', { id });
    return this.#tx(() => {
      const rooms = this.#q.ownedRooms.all(id).map((r) => r.room);
      this.#q.deleteUser.run(id);
      this.#record(actor, 'user.delete', target.username, rooms.length ? `${rooms.length} notebook(s)` : '');
      return rooms;
    });
  }

  /* ------------------------------------------------------------ sessions */

  /**
   * Check a username and password and open a session.
   * @returns {Promise<{ user: object, token: string, sessionId: number, expiresAt: number }>}
   */
  async login({ username, password, ip = null, userAgent = null }) {
    const row = typeof username === 'string' ? this.#q.userByName.get(username) : undefined;
    // Hash even for an unknown name, so response time does not reveal which
    // usernames exist.
    const ok = await verifyPassword(String(password ?? ''), row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      this.#record(null, 'login.failed', String(username ?? '').slice(0, 32));
      throw new AuthError('wrong username or password');
    }
    if (row.disabled === 1) throw new AuthError('this account is disabled');

    const token = randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = now + this.#sessionMs;
    const sessionId = this.#tx(() => {
      this.#q.purgeSessions.run(now);
      const { lastInsertRowid } = this.#q.insertSession.run(
        row.id, sha256(token), now, expiresAt, now, ip, userAgent ? String(userAgent).slice(0, 200) : null);
      this.#q.setLastLogin.run(now, row.id);
      this.#record(row, 'login', row.username);
      return Number(lastInsertRowid);
    });
    return { user: this.user(row.id), token, sessionId, expiresAt };
  }

  /** @returns {{ user: object, sessionId: number, expiresAt: number } | null} */
  session(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    return this.#live(this.#q.sessionByHash.get(sha256(token)));
  }

  #live(row) {
    const now = this.#now();
    if (!row || row.expires_at <= now || row.disabled === 1) return null;
    if (now - row.last_seen_at > SEEN_RESOLUTION_MS) this.#q.touchSession.run(now, row.session_id);
    return { user: toUser(row), sessionId: row.session_id, expiresAt: row.expires_at };
  }

  logout(sessionId) { this.#q.deleteSession.run(sessionId); }

  /** The credential a signed-in page hands its sync transport. */
  syncToken(sessionId) {
    const sig = createHmac('sha256', this.#secret).update(`sync:${sessionId}`).digest('base64url');
    return `${SYNC_PREFIX}.${sessionId}.${sig}`;
  }

  /** The live session behind a sync token, or null. */
  syncSession(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== SYNC_PREFIX || !/^\d+$/.test(parts[1])) return null;
    const expected = Buffer.from(this.syncToken(Number(parts[1])).split('.')[2]);
    const supplied = Buffer.from(parts[2]);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return this.#live(this.#q.sessionById.get(Number(parts[1])));
  }

  /* ----------------------------------------------------------- notebooks */

  createNotebook(owner, { title, encrypted = false }) {
    const clean = checkTitle(title);
    const room = `nb-${randomBytes(6).toString('hex')}`;
    return this.#tx(() => {
      const { lastInsertRowid } = this.#q.insertNotebook.run(room, clean, owner.id, encrypted ? 1 : 0, this.#now());
      this.#record(owner, 'notebook.create', clean, encrypted ? 'encrypted' : '');
      return { ...toNotebook(this.#q.notebookById.get(lastInsertRowid)), role: 'owner' };
    });
  }

  notebook(id) { return toNotebook(this.#q.notebookById.get(id)) ?? null; }
  notebookByRoom(room) { return toNotebook(this.#q.notebookByRoom.get(room)) ?? null; }
  notebooksOf(user) { return this.#q.notebooksOf.all(user.id).map(toNotebook); }
  notebooks() { return this.#q.allNotebooks.all().map(toNotebook); }

  /** The member role `user` holds on notebook `id`, or null. */
  roleIn(id, user) { return this.#q.membership.get(id, user.id)?.role ?? null; }

  renameNotebook(id, title, actor) {
    const clean = checkTitle(title);
    const before = this.notebook(id);
    if (!before) throw new ValidationError('no such notebook', { id });
    this.#tx(() => {
      this.#q.renameNotebook.run(clean, id);
      this.#record(actor, 'notebook.rename', before.title, clean);
    });
    return this.notebook(id);
  }

  /** @returns {string} the room whose operation log is now orphaned */
  deleteNotebook(id, actor) {
    const before = this.notebook(id);
    if (!before) throw new ValidationError('no such notebook', { id });
    this.#tx(() => {
      this.#q.deleteNotebook.run(id);
      this.#record(actor, 'notebook.delete', before.title, before.owner);
    });
    return before.room;
  }

  members(id) {
    return this.#q.members.all(id).map((m) => ({
      id: m.id, username: m.username, displayName: m.display_name, role: m.role, addedAt: m.added_at,
    }));
  }

  /** Share notebook `id` with `username`, or change their role. */
  addMember(id, username, role, actor) {
    checkOneOf(role, ['editor', 'viewer'], 'role');
    const notebook = this.notebook(id);
    if (!notebook) throw new ValidationError('no such notebook', { id });
    const row = typeof username === 'string' ? this.#q.userByName.get(username.trim()) : undefined;
    if (!row) throw new ValidationError(`there is no user called "${String(username ?? '').trim()}"`);
    if (row.id === notebook.ownerId) throw new ValidationError('the owner already has full access');
    this.#tx(() => {
      this.#q.upsertMember.run(id, row.id, role, this.#now());
      this.#record(actor, 'notebook.share', notebook.title, `${row.username} as ${role}`);
    });
    return this.members(id);
  }

  removeMember(id, userId, actor) {
    const notebook = this.notebook(id);
    if (!notebook) throw new ValidationError('no such notebook', { id });
    if (userId === notebook.ownerId) throw new ValidationError('the owner cannot be removed; delete the notebook instead');
    const target = this.#q.userById.get(userId);
    this.#tx(() => {
      this.#q.deleteMember.run(id, userId);
      this.#record(actor, actor?.id === userId ? 'notebook.leave' : 'notebook.unshare', notebook.title, target?.username ?? userId);
    });
    return this.members(id);
  }

  /* ---------------------------------------------------- sync authorisation */

  /**
   * The access `user` has to sync room `room`: a member role, 'admin' for an
   * administrator on any notebook, or null.
   */
  access(room, user) {
    if (!user || typeof room !== 'string') return null;
    if (user.role === 'admin') return this.#q.notebookByRoom.get(room) ? 'admin' : null;
    return this.#q.access.get(room, user.id)?.role ?? null;
  }

  /**
   * An `authorize` hook for {@link SyncServer}: a sync token from a live
   * session, for a notebook the user may open. With `roomTokenSecret`, signed
   * room tokens (`rv1.…`, see `#server/tokens`) are accepted as well, so the
   * Android daemon and command-line clients keep working on the same server.
   */
  authorizer({ roomTokenSecret } = {}) {
    const tokens = roomTokenSecret ? roomTokens(roomTokenSecret) : null;
    return (ctx) => {
      const credential = ctx.credential ?? '';
      if (tokens && credential.startsWith('rv1.')) return tokens(ctx);

      const live = this.syncSession(credential);
      if (!live) throw new AuthError('sign in to sync');
      const { user } = live;
      if (ctx.action === 'inspect') {
        if (user.role !== 'admin') throw new AuthError('inspection is for admins');
        return true;
      }
      const role = this.access(ctx.room, user);
      if (!role) throw new AuthError('you are not a member of this notebook', { room: ctx.room });
      if (ctx.writes && role === 'viewer') throw new AuthError('this notebook is shared with you read-only');
      return true;
    };
  }

  /* --------------------------------------------------------------- admin */

  counts() { return { ...this.#q.counts.get(this.#now()), bytes: this.#q.pages.get().bytes }; }

  audit(limit = 100) {
    return this.#q.recentAudit.all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  /** Every table, index, trigger and view, with the SQL that made it. */
  schema() {
    return this.#q.objects.all().map((o) => ({
      ...o,
      rows: o.type === 'table' ? this.#db.prepare(`SELECT count(*) AS n FROM "${o.name.replaceAll('"', '""')}"`).get().n : null,
    }));
  }

  /** Make sure an account exists; used to seed a deployment from its environment. */
  async ensureUser({ username, password, role = 'user', displayName = '' }) {
    const existing = this.userByName(username);
    if (existing) return { user: existing, created: false };
    return { user: await this.createUser({ username, password, role, displayName }, SYSTEM), created: true };
  }
}

const SYSTEM = Object.freeze({ id: null, username: 'system' });
// A real hash of a random password: verifying against it costs what a real
// login costs, and nothing matches it.
const DUMMY_HASH = await hashPassword(randomBytes(18).toString('base64url'));
