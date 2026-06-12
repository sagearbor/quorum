# Quorum — Demo Runbook

> How to bring Quorum up for a demo and tear it back down to $0. Written after the
> post–Duke Tech Expo 2026 cloud teardown (2026-06-12). Read this first if it's been a while.

## TL;DR — what state are we in right now?

As of **2026-06-12**, everything is **torn down to $0 and not publicly reachable**:

| Service | State | Cost |
|---|---|---|
| **Railway** (`quorum-api` backend) | Public domain deleted, deployment removed, **Hobby subscription canceled** (ends 2026-06-23) | **$0** |
| **Supabase** (Postgres) | **Free plan**, auto-pauses after ~7 days idle | **$0** |
| **Vercel** (frontend) | Status unconfirmed — check dashboard before assuming it's down | likely $0 (free) |
| **GitHub Pages** | Serves `/docs` markdown only (harmless) | $0 |

The app has **no authentication** — anything publicly deployed is open to the world. That's
why the cloud backend was torn down. The two demo paths below avoid that problem.

---

## Recommended: local laptop demo ($0, nothing public)

Best for a quick demo. Everything runs on your laptop — no cloud, no exposure, no Railway, no
hibernation to babysit. Pick the variant that matches what you want to show.

```bash
# From repo root.

# 1) FULLY OFFLINE — SQLite + mocked AI. No keys, no Supabase, no API spend. Most reliable.
./scripts/start.sh --local
#   → API on http://localhost:8000  ·  Web on http://localhost:3000

# 2) REAL AI synthesis — uses Supabase + the real OpenAI/Azure keys in your .env.
#    (Wake Supabase first if it's paused — see below. This spends YOUR LLM credits, locally.)
./scripts/start.sh
#   → API on http://localhost:8000  ·  Web on http://localhost:3000

# 3) FRONTEND-ONLY canned demo — no backend at all, scripted fake contributions.
NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm --filter web dev
#   → Web on http://localhost:3000
```

Notes:
- First run auto-installs deps (`pip install` for the API, `pnpm install` for web). Allow a minute.
- Open **http://localhost:3000** in the browser for the demo. API docs at http://localhost:8000/docs.
- `--local` mode needs **no API keys** and cannot spend money — use it if you just need to show the UX/flow.
- Use plain `./scripts/start.sh` only when you specifically want real LLM output on stage.
- `Ctrl-C` stops everything. Done. Nothing was ever public.

### If using real Supabase (variant 2): wake it first
Supabase free projects **auto-pause after ~7 days of inactivity**. Before the demo:
1. Go to https://supabase.com/dashboard/projects → open the Quorum project.
2. If it shows **Paused**, click **Restore** (takes ~1–2 min).
3. Once awake it stays up through your session — fine for an hour-long demo. Your instinct is right:
   wake it, then it's good for the duration; you don't need to keep poking it.

---

## Alternative: cloud demo (always-on URL, costs $5/mo)

Only do this if you need a shareable URL that's up without your laptop. **Railway requires the
Hobby plan ($5/mo) to host a running service** — the free "Trial" is a one-time $5 credit, not a
recurring free host. So this path means re-subscribing.

Steps to bring the cloud backend back (config + env vars are still saved in Railway):
1. **railway.com/account** → workspace → **Settings → Billing/Plans → re-subscribe to Hobby ($5/mo).**
2. Open the **`quorum-api`** service → **Deployments → Redeploy** (or trigger a deploy from GitHub).
3. **Service → Settings → Networking → Generate Domain** (this gives a NEW public URL).
4. In **Vercel** (frontend project) → Settings → Environment Variables → set
   **`NEXT_PUBLIC_API_URL`** to the new Railway domain → redeploy the frontend.
5. Wake Supabase if paused (see above).
6. **Because the app has no auth, anyone with the URL can use it and spend LLM credits.** Turn on
   **Vercel → Settings → Deployment Protection → Password Protection** if you want to gate it.

### Tear back down after the cloud demo
1. Railway → `quorum-api` service → **Settings → Networking** → delete the public domain.
2. Railway → service → **Deployments** → active deploy → **⋯ → Remove**.
3. Railway → workspace **Settings → Billing → Cancel Plan → "Stop deployments and cancel subscription"**.
   (Cancellation is under **Billing**, NOT the Plans page. Canceling is workspace-level — removing the
   service alone does NOT stop the $5/mo.)
4. Supabase can be left on Free; it auto-pauses itself.

---

## Reference

- **Railway env vars** already stored in the `quorum-api` service (so a redeploy needs no re-entry):
  `AZURE_OPENAI_*` (KEY, ENDPOINT, DEPLOYMENT, DEPLOYMENT_T2/T3, API_VERSION), `OPENAI_API_KEY`,
  `OPENAI_MODEL_T2`, `QUORUM_LLM_PROVIDER`, `QUORUM_TEST_MODE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_KEY`, `PORT`.
- **LLM credit safety:** Azure OpenAI uses managed identity tied to your local `az login`, so a cloud
  server can't reach it — only `OPENAI_API_KEY` is a real public-spend risk if the backend is exposed.
- **Local backend port:** the unified script uses `:8000`; the older `start-api.sh` used `:9000`
  (and `next.config.js` falls back to `127.0.0.1:9000`). Stick with `./scripts/start.sh` for consistency.
- Main dev machine is the **Mac** (trunk); this repo's deploy config lives in the cloud dashboards, not
  in git (there is no `railway.json` / `vercel.json`).
