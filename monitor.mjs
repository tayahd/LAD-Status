// LAD uptime checker. Runs every 5 minutes (GitHub Actions cron), probes each
// service, updates status.json, and sends a push through ntfy when something goes
// down or comes back up. Based on the Pulse status monitor.
//
// Env (set in the repo's Settings, Secrets and variables, Actions):
//   SITE_URL                  variable: LAD's address, like https://lad-tay.vercel.app/
//   SUPABASE_URL              variable: LAD's Supabase Project URL
//   SUPABASE_PUBLISHABLE_KEY  secret: LAD's publishable key (sb_publishable_...)
//   VERCEL_BYPASS             secret, optional: Vercel "Protection Bypass for Automation"
//                             secret, so the website check can see the real app behind
//                             Vercel Authentication. Without it the check only proves
//                             Vercel is answering.
//   NTFY_TOPIC                secret: ntfy topic to push to (no topic = no pushes)
//   NTFY_SERVER               default https://ntfy.sh
//   DASHBOARD_URL             link opened when you tap a notification
//   STATE_FILE                path to status.json (default ./status.json)
//
// `node monitor.mjs --test-notify` sends a test push and exits.

import { readFile, writeFile } from 'node:fs/promises';

const env = process.env;
const STATE_FILE = env.STATE_FILE || './status.json';
const SITE_URL = (env.SITE_URL || '').trim();
const SB = (env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const KEY = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '').trim();
const BYPASS = (env.VERCEL_BYPASS || '').trim();
const NTFY_SERVER = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = env.NTFY_TOPIC || '';
const DASHBOARD_URL = env.DASHBOARD_URL || '';
const CRON_SECRET = (env.LAD_CRON_SECRET || '').trim(); // same value as CRON_SECRET in Supabase; enables the outside-service checks
const NOW = new Date();
// Outside services each use a little of a monthly allowance, so they are checked less often:
// TMDB and Unsplash every 30 minutes, AirLabs every 6 hours (its free plan allows about 1,000 calls a month).
const DUE_HALF_HOUR = NOW.getUTCMinutes() % 30 < 5;
const DUE_SIX_HOURS = NOW.getUTCHours() % 6 === 0 && NOW.getUTCMinutes() < 5;

const TIMEOUT_MS = 15000;
const SLOW_MS = 4000;         // ok but slower than this = degraded
const RETRY_DELAY_MS = Number(env.RETRY_DELAY_MS ?? 15000); // confirm a failure before calling it down
const RECENT_MAX = 288;       // 24h of 5-minute checks
const DAILY_DAYS = 90;
const INCIDENTS_MAX = 100;

// New Supabase keys (sb_publishable_...) go in the apikey header only; older JWT anon keys also go in Authorization.
const sbHeaders = !KEY ? {} : KEY.startsWith('eyJ') ? { apikey: KEY, Authorization: `Bearer ${KEY}` } : { apikey: KEY };

const SERVICES = [
  SITE_URL && {
    id: 'web', name: 'Website', group: 'Vercel', url: SITE_URL, redirect: 'manual',
    headers: BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {},
    validate: (res, body) => {
      if (res.ok) return body.includes('id="root"') ? null : `HTTP ${res.status} (app shell missing)`;
      // Vercel Authentication answering for a signed-out visitor still proves the site is being served.
      const protectedResponse = res.status === 401 || (res.status >= 300 && res.status < 400 && /vercel\.com/i.test(res.headers.get('location') || ''));
      if (protectedResponse && !BYPASS) return null;
      if (protectedResponse) return `HTTP ${res.status} (Vercel protection blocked the check: is VERCEL_BYPASS still valid?)`;
      return `HTTP ${res.status}`;
    },
  },
  SB && KEY && {
    id: 'auth', name: 'Sign-in', group: 'Supabase Auth', url: `${SB}/auth/v1/health`, headers: sbHeaders, supabase: true,
  },
  SB && KEY && {
    // Signed-out visitors must be refused (0001_hub_items.sql revokes access), so "permission denied"
    // is the healthy answer: it proves the database responded and is still locked.
    id: 'db', name: 'Database', group: 'Supabase REST', url: `${SB}/rest/v1/items?select=id&limit=1`, headers: sbHeaders, supabase: true,
    validate: (res, body) => {
      if ((res.status === 401 || res.status === 403) && body.includes('42501')) return null;
      if (res.ok) return 'Signed-out visitors can query the items table. Run supabase/0001_hub_items.sql again in the SQL Editor';
      if (res.status === 404 || body.includes('PGRST205')) return 'The items table is missing. Run supabase/0001_hub_items.sql in the SQL Editor';
      return `HTTP ${res.status}`;
    },
  },
  // Server functions: anything but "not found" or a crash means the function is deployed and starting.
  ...(SB ? ['send-reminders', 'apple-calendar-sync', 'flight-lookup', 'media-search', 'places', 'widget', 'health'] : []).map((fn) => ({
    id: `fn-${fn}`, name: fn, group: 'Server functions', url: `${SB}/functions/v1/${fn}`, headers: sbHeaders,
    validate: (res, body) => {
      if (res.status === 404 || /NOT_FOUND|Requested function was not found/i.test(body)) return `Not deployed. Create the ${fn} function in Supabase`
      if (res.status >= 500 || /BOOT_ERROR|WORKER_LIMIT/i.test(body)) return `Crashed (HTTP ${res.status}). Check its Logs in Supabase`
      return null
    },
  })),
  // Scheduled jobs: did they actually run recently? (The health function reports when they last ran.)
  SB && {
    id: 'sched-reminders', name: 'Reminders schedule', group: 'Schedules', url: `${SB}/functions/v1/health`, headers: sbHeaders,
    validate: (res, body) => scheduleCheck(res, body, (d) => d.reminders, 3, 'The every-minute reminders job has not run. Check Integrations, Cron in Supabase'),
  },
  SB && {
    id: 'sched-apple', name: 'Apple Calendar sync', group: 'Schedules', url: `${SB}/functions/v1/health`, headers: sbHeaders,
    validate: (res, body) => {
      let d; try { d = JSON.parse(body) } catch { return `Health check unreadable (HTTP ${res.status})` }
      if (!d.apple) return null // Apple sync is not set up; nothing to watch
      if (d.apple.ok === false) return 'The last Apple sync failed. Open LAD, Settings, Apple Calendar for the reason'
      return scheduleCheck(res, body, (x) => x.apple.lastRun, 15, 'Apple sync has not run in 15 minutes. Check the lad-apple-calendar job in Supabase Cron')
    },
  },
  SB && {
    id: 'storage', name: 'Photo storage', group: 'Supabase Storage', url: `${SB}/functions/v1/health`, headers: sbHeaders,
    validate: (res, body) => { let d; try { d = JSON.parse(body) } catch { return `Health check unreadable (HTTP ${res.status})` } return d.storage?.ok ? null : `Photo storage problem: ${d.storage?.error ?? 'unknown'}. Run supabase/0005_photos.sql` },
  },
  // Outside services LAD borrows data from.
  {
    id: 'ext-weather', name: 'Weather (Open-Meteo)', group: 'Outside services', url: 'https://api.open-meteo.com/v1/forecast?latitude=41.88&longitude=-87.63&current=temperature_2m',
    validate: (res, body) => (res.ok && body.includes('temperature_2m') ? null : `HTTP ${res.status}`),
  },
  ...[['tmdb', 'Posters (TMDB)', DUE_HALF_HOUR], ['unsplash', 'Trip photos (Unsplash)', DUE_HALF_HOUR], ['airlabs', 'Flights (AirLabs)', DUE_SIX_HOURS]]
    .filter(([, , due]) => SB && CRON_SECRET && due)
    .map(([key, name]) => ({
      id: `ext-${key}`, name, group: 'Outside services', url: `${SB}/functions/v1/health?check=${key}`, headers: { ...sbHeaders, 'x-cron-secret': CRON_SECRET },
      validate: (res, body) => {
        let d; try { d = JSON.parse(body) } catch { return `Health check unreadable (HTTP ${res.status})` }
        if (d.error) return d.error
        const r = d.services?.[key]
        return r?.ok ? null : (r?.error ?? 'No answer')
      },
    })),
].filter(Boolean);

/** Reads a "last ran at" time from the health answer and fails if it is older than `maxMinutes`. */
function scheduleCheck(res, body, pick, maxMinutes, message) {
  let d; try { d = JSON.parse(body) } catch { return `Health check unreadable (HTTP ${res.status}). Is the health function deployed?` }
  if (res.status === 404) return 'The health function is not deployed'
  let at; try { at = pick(d) } catch { at = null }
  if (!at) return `${message} (never ran)`
  const age = (Date.now() - Date.parse(at)) / 60000
  return age > maxMinutes ? `${message} (last ran ${Math.round(age)} min ago)` : null
}

const UP = 0, DEGRADED = 1, DOWN = 2;
const LABEL = ['up', 'degraded', 'down'];

async function probe(svc) {
  const started = performance.now();
  try {
    const res = await fetch(svc.url, {
      method: svc.method || 'GET',
      headers: { 'User-Agent': 'lad-status-monitor', ...svc.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: svc.redirect || 'follow',
    });
    const body = await res.text();
    const ms = Math.round(performance.now() - started);
    const error = svc.validate ? svc.validate(res, body) : (res.ok ? null : `HTTP ${res.status}`);
    if (error) return { s: DOWN, ms, code: res.status, error };
    return { s: ms > SLOW_MS ? DEGRADED : UP, ms, code: res.status, error: null };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const code = e.cause?.code || ''
    // Plain-English versions of the network errors you are most likely to see.
    const error = e.name === 'TimeoutError' ? `Timed out after ${TIMEOUT_MS / 1000}s`
      : code === 'EAI_AGAIN' || code === 'ENOTFOUND' ? `Can't find ${new URL(svc.url).host}. Check the address (SUPABASE_URL or SITE_URL in GitHub)`
      : code === 'ECONNREFUSED' ? 'Connection refused'
      : code === 'CERT_HAS_EXPIRED' ? 'Security certificate expired'
      : (code || e.message);
    return { s: DOWN, ms, code: 0, error };
  }
}

async function check(svc) {
  const first = await probe(svc);
  if (first.s !== DOWN) return first;
  await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  return probe(svc);
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function notify({ title, message, priority = 3, tags = [] }) {
  if (!NTFY_TOPIC) {
    console.log(`[no NTFY_TOPIC] would push: ${title} — ${message}`);
    return;
  }
  const res = await fetch(NTFY_SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: NTFY_TOPIC, title, message, priority, tags,
      ...(DASHBOARD_URL ? { click: DASHBOARD_URL } : {}),
    }),
  });
  if (!res.ok) console.error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  else console.log(`pushed: ${title}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { services: {}, incidents: [] };
  }
}

async function main() {
  if (process.argv.includes('--test-notify')) {
    await notify({ title: 'LAD Status test', message: 'Push notifications are working.', tags: ['bell'] });
    return;
  }

  const missing = [!SITE_URL && 'SITE_URL', !SB && 'SUPABASE_URL', !KEY && 'SUPABASE_PUBLISHABLE_KEY'].filter(Boolean);
  if (missing.length) console.warn(`Not set, so those checks are skipped: ${missing.join(', ')}`);
  if (!SERVICES.length) { console.error('Nothing to check. Set SITE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.'); process.exit(1); }

  const state = await loadState();
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const results = await Promise.all(SERVICES.map(check));
  const alerts = [];

  SERVICES.forEach((svc, i) => {
    const r = results[i];
    const prev = state.services[svc.id] || { status: 'up', since: nowIso, recent: [], daily: {} };
    const prevDown = prev.status === 'down';
    const isDown = r.s === DOWN;
    const status = LABEL[r.s];

    if (isDown && !prevDown) {
      state.incidents.unshift({ service: svc.id, name: svc.name, start: nowIso, end: null, error: r.error });
      alerts.push({ kind: 'down', svc, r });
    } else if (!isDown && prevDown) {
      const open = state.incidents.find(x => x.service === svc.id && !x.end);
      if (open) open.end = nowIso;
      alerts.push({ kind: 'up', svc, r, downFor: now - new Date(prev.since) });
    }

    const recent = [...(prev.recent || []), [Math.floor(now / 1000), r.ms, r.s]].slice(-RECENT_MAX);
    const daily = { ...prev.daily };
    const d = daily[today] || { n: 0, up: 0, deg: 0, ms: 0 };
    d.n++; d.ms += r.ms;
    if (r.s === UP) d.up++;
    if (r.s === DEGRADED) d.deg++;
    daily[today] = d;
    const cutoff = new Date(now - DAILY_DAYS * 864e5).toISOString().slice(0, 10);
    for (const k of Object.keys(daily)) if (k < cutoff) delete daily[k];

    state.services[svc.id] = {
      name: svc.name, group: svc.group, status,
      since: prev.status === status ? prev.since : nowIso,
      lastMs: r.ms, lastCode: r.code, lastError: r.error,
      recent, daily,
    };
    console.log(`${svc.name.padEnd(10)} ${status.padEnd(9)} ${String(r.ms).padStart(5)}ms ${r.error || ''}`);
  });

  // Drop services that were removed from the list.
  for (const id of Object.keys(state.services)) if (!SERVICES.some(s => s.id === id)) delete state.services[id];
  state.incidents = state.incidents.slice(0, INCIDENTS_MAX);
  state.updatedAt = nowIso;
  state.intervalMinutes = 5;
  state.siteUrl = SITE_URL;
  await writeFile(STATE_FILE, JSON.stringify(state));

  const downs = alerts.filter(a => a.kind === 'down');
  const ups = alerts.filter(a => a.kind === 'up');
  if (downs.length) {
    // Every Supabase check failing at once usually means the project is paused (free plan, a week unused).
    const sbChecks = SERVICES.map((s, i) => [s, results[i]]).filter(([s]) => s.supabase);
    const allSupabaseDown = sbChecks.length > 0 && sbChecks.every(([, r]) => r.s === DOWN);
    const hint = allSupabaseDown && downs.some(a => a.svc.supabase)
      ? '\nIf this lasts, the Supabase project may be paused: open supabase.com and click Restore.'
      : '';
    await notify({
      title: downs.length === 1 ? `LAD ${downs[0].svc.name} is down` : `${downs.length} LAD services are down`,
      message: downs.map(a => `${a.svc.name}: ${a.r.error}`).join('\n') + hint,
      priority: 5, tags: ['rotating_light'],
    });
  }
  if (ups.length) {
    await notify({
      title: ups.length === 1 ? `LAD ${ups[0].svc.name} is back up` : `${ups.length} LAD services recovered`,
      message: ups.map(a => `${a.svc.name} recovered after ${fmtDuration(a.downFor)} (${a.r.ms}ms)`).join('\n'),
      priority: 3, tags: ['white_check_mark'],
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
