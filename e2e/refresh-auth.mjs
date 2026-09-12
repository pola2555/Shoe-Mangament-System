/**
 * Mint a fresh Playwright storage state without running the setup project.
 *
 * WHY THIS EXISTS
 *
 * `auth.setup.js` is the right way to authenticate a full run, and it refuses to start
 * unless the API's rate limit has been raised — a guard that has already saved two runs
 * from dying on a 429 that looked like missing data.
 *
 * But that means the suite cannot run at all against a backend somebody else started,
 * such as the developer's own `npm run dev`. This mints a token against whatever is
 * listening so a HANDFUL of specs can be run with `--no-deps` for a quick check, well
 * under the 200/min production ceiling.
 *
 * It is NOT a substitute for a real run. The access token lives fifteen minutes, so a
 * long suite will still walk into the login screen partway through — which is exactly
 * what it did, and why this file has a warning in it rather than being used by default.
 *
 *   node e2e/refresh-auth.mjs
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.CHECK_BASE || 'http://localhost:5000/api';
const ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';
const STATE_FILE = path.join(process.cwd(), 'e2e', '.auth', 'admin.json');

/**
 * The refresh token in the saved state, if there is one and it still works.
 *
 * /auth/login allows ten attempts per fifteen minutes and /auth/refresh has its own,
 * far higher limiter — deliberately, because a few open tabs used to exhaust the login
 * one and throw everybody back to the sign-in screen. So a token that has merely
 * EXPIRED (fifteen minutes) is renewed here without spending a login attempt. Running
 * two or three HTTP check suites is enough to use them all up otherwise.
 */
async function viaRefresh() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const entry = (saved.origins?.[0]?.localStorage || []).find((x) => x.name === 'refreshToken');
    if (!entry?.value) return null;
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: entry.value }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.data || null;
  } catch {
    return null;
  }
}

let data = await viaRefresh();

if (data) {
  console.log('renewed from the saved refresh token — no login attempt spent');
} else {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });

  if (!res.ok) {
    console.error(`login failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  ({ data } = await res.json());
}
const access = data.accessToken || data.access_token || data.token;
const refresh = data.refreshToken || data.refresh_token;

if (!access) {
  console.error('no access token in the login response');
  process.exit(1);
}

// Mirrors what the app itself writes, so a page loaded with this state behaves exactly
// as it would after a real sign-in.
const localStorage = [{ name: 'accessToken', value: access }];
if (refresh) localStorage.push({ name: 'refreshToken', value: refresh });
if (data.user) {
  localStorage.push({ name: 'user', value: JSON.stringify(data.user) });
} else if (fs.existsSync(STATE_FILE)) {
  // /auth/refresh returns tokens only. Carry the profile the last sign-in wrote, or a
  // renewed state would load a page that has a valid token and no idea who is holding
  // it — which reads as a broken app rather than as a stale fixture.
  const prior = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const user = (prior.origins?.[0]?.localStorage || []).find((x) => x.name === 'user');
  if (user) localStorage.push(user);
}

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({
  cookies: [],
  origins: [{ origin: ORIGIN, localStorage }],
}, null, 2));

console.log(`fresh admin state written to ${STATE_FILE}`);
