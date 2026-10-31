/** @file The sign-in and sign-up page. */

import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const next = new URLSearchParams(location.search).get('next');
// Only ever return to a path on this site, never to a URL someone put in a link.
const destination = next && /^\/(?![/\\])/.test(next) ? next : '/';

function show(tab) {
  const register = tab === 'register';
  $('tab-login').setAttribute('aria-selected', String(!register));
  $('tab-register').setAttribute('aria-selected', String(register));
  $('login-form').hidden = register;
  $('register-form').hidden = !register;
  $('error').hidden = true;
  (register ? $('register-form') : $('login-form')).querySelector('input').focus();
}

$('tab-login').onclick = () => show('login');
$('tab-register').onclick = () => show('register');

async function submit(form, path) {
  const button = form.querySelector('button[type="submit"]');
  const fields = Object.fromEntries(new FormData(form));
  button.disabled = true;
  $('error').hidden = true;
  try {
    await api('POST', path, fields);
    location.replace(destination);
  } catch (err) {
    $('error').textContent = err.message;
    $('error').hidden = false;
    button.disabled = false;
  }
}

// The submit buttons start disabled in the HTML and are enabled only here,
// once these handlers are attached: on a slow link the browser must never get
// the chance to submit a form itself, which would send the password somewhere
// other than the API.
$('login-form').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, '/api/auth/login'); };
$('register-form').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, '/api/auth/register'); };
for (const button of document.querySelectorAll('button[type="submit"]')) button.disabled = false;

const response = await fetch('/api/me', { credentials: 'same-origin' });
if (response.status === 404) location.replace('/'); // a server without accounts
const { user = null, signup = true } = response.ok ? await response.json() : {};
if (user) location.replace(destination);
if (!signup) $('tab-register').hidden = true;
if (location.hash === '#register' && signup) show('register');
