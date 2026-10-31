/**
 * @file A small client for the accounts API (`/api`), shared by the pages.
 *
 * The session is an HttpOnly cookie the page never sees; every call here just
 * rides on it. Errors come back as `ApiError` with the server's message, which
 * is written to be shown to a person as is.
 */

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch { /* an empty or non-JSON reply */ }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `request failed (${response.status})`);
  return data;
}

/**
 * Who is signed in. Resolves to `null` when this server has no accounts at
 * all (the plain demo), and sends the browser to the sign-in page when it has
 * them but nobody is signed in.
 */
export async function currentSession() {
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, 'could not reach the server');
  const me = await response.json();
  if (!me.user) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`/login.html?next=${encodeURIComponent(next)}`);
    return new Promise(() => {}); // the page is going away
  }
  return me;
}

export async function signOut() {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.replace('/login.html');
}

/** `12 Oct, 21:40` for today-ish timestamps, a date otherwise. */
export function when(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Build an element: `h('td', { className: 'num' }, 'text', child)`. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
