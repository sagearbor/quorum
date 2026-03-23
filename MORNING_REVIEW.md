# Morning Review — Hacks to Fix Properly

Generated 2026-03-23. These are shortcuts that need proper cleanup before expo.

## ✅ Fixed Overnight

### 1. `NEXT_PUBLIC_` env var hack
- **What I did**: Created `apps/web/.env.local` by copying values from root `.env` at runtime
- **Why it's wrong**: Fragile — if root `.env` changes, `.env.local` is stale. Also not committed.
- **Proper fix**: `apps/web/.env.local` should be created from a setup script, OR root `.env` should have NEXT_PUBLIC_ vars alongside SUPABASE_URL. Document in `apps/web/.env.local.example`.

### 2. EmotionDetector silent mock fallback
- **What I did**: `EmotionDetector.start()` catches MediaPipe 404 and silently falls back to mock mode
- **Why it's wrong**: Sage explicitly said NO silent mock fallbacks
- **Proper fix**: On MediaPipe load failure, log a real error and stop — no fallback to fake data. If `AVATAR_MOCK=true` is set explicitly, mock is fine. Otherwise fail visibly.

### 3. `useAvatarController` enableEmotion default
- **What I did**: Changed default from `typeof window !== "undefined"` to `false`
- **Why it's wrong**: Breaks station pages that DO need emotion tracking
- **Proper fix**: Display page should pass `enableEmotion={false}` explicitly when mounting AvatarPanel. Station pages pass `enableEmotion={true}`.

### 4. Supabase realtime "Connecting…" on graphs
- **Root cause**: `useQuorumLive` connects to Supabase for realtime updates but previously fell back to mock on error
- **Status**: Mock fallback is removed — but verify Supabase realtime actually works with real quorum ID `c6c4f8ba`
- **Proper fix**: If Supabase sub fails, show a real error state (not mock data, not silent empty)

### 5. WebSocket proxy
- **What I did**: Changed WS URL to go directly to `127.0.0.1:9000` instead of through Next.js
- **Why it's a hack**: Hardcodes local port; breaks in any deployed environment
- **Proper fix**: Read WS host from `NEXT_PUBLIC_API_URL` env var (already done), but also add WS proxy support in `next.config.mjs` via custom server, or deploy both services behind the same nginx/caddy

## 🟡 Sage Must Do (still needed) (can't be automated)

### A. Confirm AZURE_OPENAI_KEY in `.env`
The variable must be named exactly `AZURE_OPENAI_KEY` (not `AZURE_OPENAI_API_KEY`).
Verify: `grep AZURE_OPENAI_KEY /path/to/quorum/.env`

### B. Supabase free tier → upgrade before expo
Free tier pauses after 1 week of inactivity. Upgrade to Pro ($25/mo) before Duke Tech Expo.

### C. `.env.local` for `apps/web`
After agent creates `apps/web/.env.local.example`, copy and fill in:
```
cp apps/web/.env.local.example apps/web/.env.local
# fill in SUPABASE values from root .env
```

## ✅ Working (verified end-to-end)
- AI role generation via Azure gpt-5-nano ✓
- Real Supabase quorum creation ✓
- Real contributions submitted (5, health score 77.5) ✓
- `/api/events/{slug}/quorum-ids` endpoint returning real IDs ✓
- Next.js proxy `/api/*` → port 9000 ✓
- `QUORUM_TEST_MODE=false` → no mock data on backend ✓
- Branch `feature/ai-architect-working` saved ✓

## Start Services
```bash
# Terminal 1 — API
cd ~/PROJECTS/github_repos/quorum && ./start-api.sh

# Terminal 2 — Web
cd ~/PROJECTS/github_repos/quorum/apps/web && pnpm dev
```
