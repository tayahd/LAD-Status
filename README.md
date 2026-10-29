# LAD Status

Uptime monitor and status dashboard for LAD (life admin app), kept separate from the app itself. Built the same way as Pulse Status.

- **Checker:** `monitor.mjs` runs every 5 minutes via GitHub Actions (`.github/workflows/monitor.yml`).
- **Services checked:**
  - **Website (Vercel):** loads LAD's address. With `VERCEL_BYPASS` set it confirms the real app loads behind Vercel Authentication; without it, it only confirms Vercel is answering.
  - **Sign-in (Supabase Auth):** Supabase's health check for logins.
  - **Database (Supabase REST):** asks for the `items` table as a signed-out visitor. The healthy answer is "permission denied". That proves the database answered and is still locked. If a signed-out visitor can read the table, or the table is missing, it reports down and says what to fix.
- **Not checked:** live sync between devices (Supabase Realtime). If sign-in and the database are up, sync normally is too.
- **Data:** written to `status.json` on the `data` branch (one commit, force-pushed each run).
- **Dashboard:** `index.html`, served by GitHub Pages at https://tayahd.github.io/lad-status/
- **Push alerts:** sent through [ntfy](https://ntfy.sh). A failure is retried after 15s before it counts as down. You get an urgent push when a service goes down and a normal one when it recovers. If every Supabase check is down at once, the push reminds you the project may be paused.

## Settings (repo Settings, Secrets and variables, Actions)

| Kind | Name | Value |
|---|---|---|
| Variable | `SITE_URL` | LAD's address from Vercel, Settings, Domains, like `https://lad-tay.vercel.app/` |
| Variable | `SUPABASE_URL` | LAD's Supabase Project URL |
| Secret | `SUPABASE_PUBLISHABLE_KEY` | LAD's publishable key (`sb_publishable_...`). Never the secret or service_role key |
| Secret | `NTFY_TOPIC` | a new ntfy topic for LAD, separate from Pulse's |
| Secret | `VERCEL_BYPASS` | optional: Vercel, Settings, Deployment Protection, Protection Bypass for Automation |

## Phone setup
1. In the **ntfy** app, tap **+** and subscribe to the LAD topic (server: ntfy.sh).
2. Actions, Monitor, *Run workflow*, tick "Send a test push notification".

Keep the topic name private. Anyone who knows it can read or send to it.

## Upkeep
- GitHub pauses scheduled workflows in a repository with no activity for 60 days and emails you first. If it happens, open Actions, Monitor, and click **Enable workflow**.
- This repository is public (free GitHub Pages and unlimited Actions minutes need that). `status.json` shows LAD's address and Supabase URL, both of which are public by design. Never commit a key.

## Local run
```
SITE_URL=... SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... node monitor.mjs   # writes ./status.json, prints results
NTFY_TOPIC=... node monitor.mjs --test-notify
python3 -m http.server                                                        # dashboard reads ./status.json locally
```

## New checks (server functions, schedules, storage, outside services)
1. In the LAD project: run `supabase/0008_heartbeat.sql`, create the `health` function (JWT verification off), and update `send-reminders`.
2. In this repository: Settings, Secrets and variables, Actions, New repository secret: `LAD_CRON_SECRET` = the same value as `CRON_SECRET` in Supabase. Without it, the TMDB, Unsplash and AirLabs checks are skipped (everything else still runs).
3. Outside services are checked less often to save their allowances: TMDB and Unsplash every 30 minutes, AirLabs every 6 hours.
