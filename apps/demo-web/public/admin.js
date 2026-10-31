/** @file The admin console: accounts, notebooks, the audit log and the schema. */

import { api, currentSession, signOut, when, bytes, h } from '/api.js';

const $ = (id) => document.getElementById(id);

const session = await currentSession();
if (!session) location.replace('/'); // a server without accounts
if (session.user.role !== 'admin') {
  document.body.replaceChildren(h('main', { className: 'auth' },
    h('h1', {}, 'Admins only'),
    h('p', {}, `You are signed in as ${session.user.username}, which is not an admin account.`),
    h('p', {}, h('a', { href: '/' }, 'Back to your notebooks'))));
  throw new Error('not an admin');
}
const me = session.user;
$('who').textContent = me.displayName || me.username;
$('who').title = `signed in as ${me.username} (admin)`;
$('sign-out').onclick = () => signOut();

function showError(err) {
  $('error').textContent = err ? err.message : '';
  $('error').hidden = !err;
}

/** Run an action, show its error if it fails, then re-render the tab. */
const act = (fn) => async (...args) => {
  try { showError(null); await fn(...args); } catch (err) { showError(err); }
  await renderTab(current);
};

/** A button that needs a second click within four seconds. */
function confirmButton(label, onConfirm, className = 'ghost small danger') {
  const button = h('button', { type: 'button', className }, label);
  button.onclick = () => {
    if (button.dataset.armed) return onConfirm();
    button.dataset.armed = '1';
    button.textContent = 'Confirm?';
    setTimeout(() => { delete button.dataset.armed; button.textContent = label; }, 4000);
  };
  return button;
}

/* ---------------------------------------------------------------- overview */

async function renderOverview() {
  const { accounts, sync, server } = await api('GET', '/api/admin/overview');
  const tile = (value, label, note) => h('div', { className: 'tile' },
    h('span', { className: 'tile-value' }, value), h('span', { className: 'tile-label' }, label),
    note ? h('span', { className: 'tile-note' }, note) : null);
  $('tiles').replaceChildren(
    tile(accounts.users, 'users', `${accounts.admins} admin${accounts.admins === 1 ? '' : 's'}, ${accounts.disabled} disabled`),
    tile(accounts.notebooks, 'notebooks', `${accounts.encrypted} end-to-end encrypted`),
    tile(accounts.memberships, 'memberships', 'owner, editor or viewer'),
    tile(accounts.sessions, 'active sessions'),
    tile(sync.operations.toLocaleString(), 'operations stored', `in ${sync.openRooms} open room${sync.openRooms === 1 ? '' : 's'}`),
    tile(bytes(sync.bytes), 'operation logs'),
    tile(sync.connections, 'live streams', `${sync.replicas} replica entries`),
    tile(bytes(accounts.bytes), 'accounts database', `${accounts.events} audit events`),
  );
  const uptime = server.uptimeSeconds;
  const fact = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  $('facts').replaceChildren(
    ...fact('Server replica id', h('code', {}, server.node)),
    ...fact('Started', `${when(server.startedAt)} (up ${Math.floor(uptime / 3600)} h ${Math.floor(uptime / 60) % 60} min)`),
    ...fact('Memory', `${bytes(server.rssBytes)} resident, ${bytes(server.heapBytes)} heap`),
    ...fact('Node.js', server.nodeVersion),
    ...fact('Sign-up', server.signup ? 'open to anyone' : 'closed: admins create accounts'),
  );
}

/* ------------------------------------------------------------------- users */

const passwordDialog = $('password-dialog');
let passwordTarget = null;
$('password-cancel').onclick = () => passwordDialog.close();
$('password-form').onsubmit = act(async (ev) => {
  ev.preventDefault();
  const password = ev.target.elements.password.value;
  passwordDialog.close();
  await api('PATCH', `/api/admin/users/${passwordTarget.id}`, { password });
});

$('create-user').onsubmit = act(async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  await api('POST', '/api/admin/users', Object.fromEntries(new FormData(form)));
  form.reset();
});

async function renderUsers() {
  const { users } = await api('GET', '/api/admin/users');
  $('users-table').tBodies[0].replaceChildren(...users.map((u) => {
    const self = u.id === me.id;
    const role = h('select', {
      disabled: self, title: self ? 'You cannot change your own role' : 'Change role',
      onchange: act((ev) => api('PATCH', `/api/admin/users/${u.id}`, { role: ev.target.value })),
    }, ...['user', 'admin'].map((r) => h('option', { value: r, selected: r === u.role }, r)));
    return h('tr', { className: u.disabled ? 'is-disabled' : '' },
      h('td', {}, h('code', {}, u.username), self ? h('span', { className: 'muted' }, ' (you)') : null),
      h('td', {}, u.displayName || h('span', { className: 'muted' }, '–')),
      h('td', {}, role),
      h('td', {}, h('span', { className: `pill ${u.disabled ? 'off' : 'on'}` }, u.disabled ? 'disabled' : 'active')),
      h('td', { className: 'num' }, u.notebooksOwned),
      h('td', { className: 'num' }, u.notebooksJoined),
      h('td', {}, when(u.lastLoginAt)),
      h('td', {}, when(u.createdAt)),
      h('td', { className: 'actions' },
        self ? null : h('button', {
          type: 'button', className: 'ghost small',
          onclick: act(() => api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled })),
        }, u.disabled ? 'Enable' : 'Disable'),
        h('button', {
          type: 'button', className: 'ghost small',
          onclick: () => {
            passwordTarget = u;
            $('password-title').textContent = `New password for ${u.username}`;
            $('password-form').reset();
            passwordDialog.showModal();
          },
        }, 'Reset password'),
        self ? null : confirmButton('Delete', act(() => api('DELETE', `/api/admin/users/${u.id}`)))));
  }));
}

/* --------------------------------------------------------------- notebooks */

async function renderNotebooks() {
  const { notebooks } = await api('GET', '/api/admin/notebooks');
  $('notebooks-table').tBodies[0].replaceChildren(...notebooks.map((n) => h('tr', {},
    h('td', {}, n.encrypted ? '🔒 ' : '', n.title),
    h('td', {}, h('code', {}, n.owner)),
    h('td', { className: 'num' }, n.members),
    h('td', {}, h('code', {}, n.room)),
    h('td', { className: 'num' }, n.sync?.operations?.toLocaleString() ?? '–'),
    h('td', { className: 'num' }, n.sync?.replicas ?? '–'),
    h('td', { className: 'num' }, bytes(n.sync?.bytes)),
    h('td', {}, when(n.sync?.operations ? n.sync.lastActivity : null)),
    h('td', {}, when(n.createdAt)),
    h('td', { className: 'actions' },
      n.encrypted ? null : h('a', { className: 'button ghost small', href: `/?nb=${n.id}` }, 'Open'),
      confirmButton('Delete', act(() => api('DELETE', `/api/admin/notebooks/${n.id}`)))))));
}

/* ------------------------------------------------------------------- audit */

async function renderAudit() {
  const { events } = await api('GET', '/api/admin/audit?limit=200');
  $('audit-table').tBodies[0].replaceChildren(...events.map((e) => h('tr', {},
    h('td', {}, when(e.at)),
    h('td', {}, h('code', {}, e.actor)),
    h('td', {}, h('span', { className: `action action-${e.action.split('.')[0]}` }, e.action)),
    h('td', {}, e.target),
    h('td', { className: 'muted' }, e.detail))));
}
$('audit-refresh').onclick = () => renderTab('audit');

/* ---------------------------------------------------------------- database */

async function renderDatabase() {
  const { objects } = await api('GET', '/api/admin/schema');
  const groups = ['table', 'view', 'index', 'trigger'];
  $('schema').replaceChildren(...groups.map((type) => {
    const items = objects.filter((o) => o.type === type);
    if (!items.length) return null;
    return h('section', { className: 'schema-group' },
      h('h2', {}, `${type}s (${items.length})`),
      ...items.map((o) => h('details', { open: type === 'table' },
        h('summary', {}, h('code', {}, o.name),
          o.rows !== null ? h('span', { className: 'muted' }, ` · ${o.rows} row${o.rows === 1 ? '' : 's'}`) : null,
          type !== 'table' ? h('span', { className: 'muted' }, ` · on ${o.table}`) : null),
        h('pre', { className: 'sql' }, o.sql))));
  }));
}

/* -------------------------------------------------------------------- tabs */

const renderers = {
  overview: renderOverview, users: renderUsers, notebooks: renderNotebooks,
  audit: renderAudit, database: renderDatabase,
};
let current = 'overview';

async function renderTab(tab) {
  try { await renderers[tab](); } catch (err) { showError(err); }
}

function select(tab) {
  current = tab;
  for (const button of $('tabs').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  for (const name of Object.keys(renderers)) $(`panel-${name}`).hidden = name !== tab;
  history.replaceState(null, '', `#${tab}`);
  showError(null);
  renderTab(tab);
}

for (const button of $('tabs').querySelectorAll('button')) button.onclick = () => select(button.dataset.tab);
select(renderers[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');
