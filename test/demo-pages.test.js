import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The pages must never let the browser submit a form on its own. On a slow
 * link a sign-in form can be submitted before its script has loaded, and a
 * default GET submission puts the password in the URL -- in history, in proxy
 * logs. Every form posts, and the sign-in page's submit buttons stay disabled
 * until its script, having attached the handlers, enables them.
 */

const page = (name) => readFile(new URL(`../apps/demo-web/public/${name}`, import.meta.url), 'utf8');

test('every form on every page posts, never gets', async () => {
  for (const name of ['index.html', 'login.html', 'admin.html']) {
    const forms = (await page(name)).match(/<form\b[^>]*>/g) ?? [];
    assert.ok(forms.length > 0, `${name} has forms`);
    for (const form of forms) assert.match(form, /\bmethod="post"/, `${name}: ${form}`);
  }
});

test('the sign-in buttons start disabled and are enabled before any network request', async () => {
  const html = await page('login.html');
  const buttons = html.match(/<button type="submit"[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, /\bdisabled\b/, button);

  const js = await page('login.js');
  const enable = js.indexOf("querySelectorAll('button[type=\"submit\"]')) button.disabled = false");
  const handler = js.indexOf("$('login-form').onsubmit");
  const firstFetch = js.indexOf('await fetch(');
  assert.ok(handler >= 0 && enable > handler, 'handlers are attached, then the buttons enabled');
  assert.ok(firstFetch > enable, 'and only then does the page wait on the network');
});
