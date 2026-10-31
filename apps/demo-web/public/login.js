/** @file The sign-in and sign-up page. */

import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const next = new URLSearchParams(location.search).get('next');
// Only ever return to a path on this site, never to a URL someone put in a link.
const destination = next && /^\/(?![/\\])/.test(next) ? next : '/';

const response = await fetch('/api/me', { credentials: 'same-origin' });
if (response.status === 404) location.replace('/'); // a server without accounts
const { user = null, signup = true } = response.ok ? await response.json() : {};
if (user) location.replace(destination);

function show(tab) {
  const register = tab === 'register';
  $('tab-login').setAttribute('aria-selected', String(!register));
  $('tab-register').setAttribute('aria-selected', String(register));
  $('login-form').hidden = register;
  $('register-form').hidden = !register;
  $('error').hidden = true;
  (register ? $('register-form') : $('login-form')).querySelector('input').focus();
}

if (!signup) $('tab-register').hidden = true;
$('tab-login').onclick = () => show('login');
$('tab-register').onclick = () => show('register');
if (location.hash === '#register' && signup) show('register');

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

$('login-form').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, '/api/auth/login'); };
$('register-form').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, '/api/auth/register'); };
