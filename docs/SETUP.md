# SETUP.md — Manual Setup Walkthrough

Everything you need to do by hand to get Quorum running. Checklist style — work top to bottom.

---

## 0. Machine Status (DCRI-PF4YNVSH / WSL Ubuntu 22.04)

| Tool | Required | Status | Action |
|------|----------|--------|--------|
| **Node.js** | >= 18 | v22.16.0 | Done |
| **pnpm** | >= 9 | 9.15.9 | Done |
| **Python** | >= 3.11 | 3.11.15 (via deadsnakes) | Done (`python3.11`) |
| **Docker** | Desktop or Engine | 28.4.0 | Done |
| **Supabase CLI** | >= 1.100 | 2.75.0 | Done |
| **Azure CLI** | latest | 2.77.0 | Done (upgrade available: `az upgrade`) |
| **Azure login** | logged in | dhp-dcri-prod-sub | Done |

---

## 1. Upgrade Python to 3.11+ ✅ DONE

> **Completed**: Python 3.11.15 installed via deadsnakes PPA. Use `python3.11` (not `python` or `python3`, which remain at system 3.10).

<details>
<summary>Original instructions (click to expand)</summary>

Ubuntu 22.04 ships 3.10 via apt (the system default). That's the newest Canonical will
provide for 22.04. To get 3.11+ you have two options:

**Option A: deadsnakes PPA (recommended)**

The [deadsnakes PPA](https://launchpad.net/~deadsnakes/+archive/ubuntu/ppa) is maintained
by a CPython core developer (Anthony Sottile). Packages are built from official CPython
source. It's the standard way to get newer Python on Ubuntu — widely used and trusted.

```bash
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt update
sudo apt install python3.11 python3.11-venv python3.11-dev
```

**Option B: Upgrade WSL to Ubuntu 24.04**

24.04 ships Python 3.12 natively. Bigger change but avoids the PPA:
`sudo do-release-upgrade`

Verify:

```bash
python3.11 --version
# Python 3.11.x
```

You do NOT need to change the system default (`python3` can stay at 3.10). Just use `python3.11` when creating venvs for this project:

```bash
python3.11 -m venv .venv
```

</details>

---

## 2. Install Supabase CLI ✅ DONE

> **Completed**: Supabase CLI v2.75.0 installed at `/usr/local/bin/supabase`.

<details>
<summary>Original instructions (click to expand)</summary>

> **Note**: `npm install -g supabase` is no longer supported. Use one of these methods.

**Option A: Direct binary (simplest for WSL)**

```bash
# Download latest release, extract, move to PATH
curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz | tar xz
sudo mv supabase /usr/local/bin/
```

To upgrade later, re-run the same two commands.

**Option B: Homebrew** (if you have Linuxbrew installed)

```bash
brew install supabase/tap/supabase
# upgrade later: brew upgrade supabase
```

Verify:

```bash
supabase --version
# should be >= 1.100
```

</details>

---

## 3. Accounts & Services to Set Up

These are the external accounts/resources you need. Check off as you go.

### 3a. Supabase (local — no account needed) ✅ DONE

> **Completed**: Local Supabase running. Migrations applied, seed data loaded.
> - Studio: http://127.0.0.1:54323
> - API URL: http://127.0.0.1:54321
> - Publishable key: `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`
> - Secret key: `<from supabase status>`
> - DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

**Useful commands:**

```bash
supabase status          # show running ports + keys (re-print keys anytime)
supabase db reset        # wipe and re-run migrations + seed
supabase stop            # stop containers (data preserved)
```

### 3b. Supabase Cloud (optional — for staging/prod)

Only needed if you want a hosted instance instead of local Docker.

1. Sign up at https://supabase.com/dashboard (GitHub login works)
2. Create a new project → pick a region + set DB password
3. Go to **Settings → API** → copy **Project URL** and **anon/public key** and **service_role key**
4. Go to **SQL Editor** → paste and run each file in `supabase/migrations/` in order:
   - `20260225000001_initial_schema.sql`
   - `20260225000002_rls_policies.sql`
   - `20260225000003_enable_realtime.sql`
5. Then paste and run `supabase/seed.sql` for demo data
6. Go to **Database → Replication** → enable realtime for tables: `quorums`, `contributions`, `artifacts`

### 3c. Azure OpenAI Resource ✅ DONE

> **Completed**: Resource `ai-sandbox-instance` on subscription `dhd-dcri-aisvc-sub` (not `dhp-dcri-prod-sub`).
> - Endpoint: `https://ai-sandbox-instance.openai.azure.com/`
> - Resource group: `ai-sandbox-rg`
> - Deployments verified: `gpt-4o-mini` (T2) and `gpt-4o` (T3) both exist
> - Also has newer models: gpt-4.1, gpt-5, gpt-5.1, gpt-5.2, o3, o4-mini, etc.

<details>
<summary>Original instructions (click to expand)</summary>

**Check if a resource already exists:**

```bash
az cognitiveservices account list --subscription dhd-dcri-aisvc-sub --query "[?kind=='OpenAI'].{name:name, endpoint:properties.endpoint}" -o table
```

**If you need to create one:**

1. Go to https://portal.azure.com → search "Azure OpenAI" → **Create**
2. Select subscription `dhd-dcri-aisvc-sub`, resource group `ai-sandbox-rg`
3. Pricing tier: Standard S0

**List deployments:**

```bash
az cognitiveservices account deployment list \
  --name ai-sandbox-instance \
  --resource-group ai-sandbox-rg \
  --subscription dhd-dcri-aisvc-sub \
  -o table
```

You need two deployments:

| Deployment name | Model | Used for |
|----------------|-------|----------|
| `gpt-4o-mini` | gpt-4o-mini | Tier 2: conflict detection |
| `gpt-4o` | gpt-4o | Tier 3: artifact synthesis |

**Copy the endpoint** (e.g., `https://ai-sandbox-instance.openai.azure.com/`) — you'll need it for `.env`.

</details>

### 3d. Azure RBAC for Managed Identity

> **Note**: The OpenAI resource is on subscription `dhd-dcri-aisvc-sub`, not `dhp-dcri-prod-sub`. Use `--subscription dhd-dcri-aisvc-sub` in all az commands below.

Your Azure AD user needs the `Cognitive Services OpenAI User` role on the Azure OpenAI resource.

**Check if you already have the role:**

```bash
az role assignment list \
  --assignee $(az ad signed-in-user show --query id -o tsv) \
  --scope $(az cognitiveservices account show --name ai-sandbox-instance --resource-group ai-sandbox-rg --subscription dhd-dcri-aisvc-sub --query id -o tsv) \
  -o table
```

**Assign it if missing:**

```bash
az role assignment create \
  --assignee $(az ad signed-in-user show --query id -o tsv) \
  --role "Cognitive Services OpenAI User" \
  --scope $(az cognitiveservices account show --name ai-sandbox-instance --resource-group ai-sandbox-rg --subscription dhd-dcri-aisvc-sub --query id -o tsv)
```

> Role assignment can take **up to 5 minutes** to propagate. If you get 401s right after, wait and retry.

**Reference**: https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/managed-identity

**Fallback — API key** (if RBAC isn't available):

```bash
az cognitiveservices account keys list \
  --name ai-sandbox-instance \
  --resource-group ai-sandbox-rg \
  --subscription dhd-dcri-aisvc-sub \
  -o table
```

Then set `AZURE_OPENAI_USE_MANAGED_IDENTITY=false` and `AZURE_OPENAI_KEY=<key>` in `.env`.

---

## 4. Python Backend Setup ✅ DONE

> **Completed**: venv at `apps/api/.venv` (Python 3.11.15), all deps installed including `quorum-llm[dev,azure]`.

<details>
<summary>Original instructions (click to expand)</summary>

```bash
cd apps/api
python3.11 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt

# LLM package (editable, with dev + azure deps)
pip install -e "../../packages/llm[dev,azure]"
```

Verify:

```bash
python -c "import quorum_llm; print('OK')"
python -c "from azure.identity import DefaultAzureCredential; print('azure-identity OK')"
```

</details>

---

## 5. Environment Files ✅ DONE

> **Completed**: Both env files created with real values.
> - `.env` — API key auth (managed identity needs RBAC role assignment, using key fallback)
> - `apps/web/.env.local` — local Supabase + API URLs

<details>
<summary>Original instructions (click to expand)</summary>

### Repo root: `.env` (backend, loaded by python-dotenv)

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
SUPABASE_SERVICE_KEY=<from supabase status>

AZURE_OPENAI_ENDPOINT=https://ai-sandbox-instance.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_T2=gpt-4o-mini
AZURE_OPENAI_DEPLOYMENT_T3=gpt-4o
AZURE_OPENAI_USE_MANAGED_IDENTITY=false
AZURE_OPENAI_KEY=<in .env file>

QUORUM_LLM_PROVIDER=azure
NEXTAUTH_SECRET=<in .env file>
```

### Frontend: `apps/web/.env.local`

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
NEXT_PUBLIC_API_URL=http://localhost:8000
```

</details>

---

## 6. Install & Run

```bash
# Frontend dependencies (from repo root)
pnpm install

# Start everything (3 terminals):

# Terminal 1: Supabase (if not already running)
supabase start

# Terminal 2: Backend
cd apps/api
source .venv/bin/activate
uvicorn apps.api.main:app --reload --port 8000

# Terminal 3: Frontend
pnpm --filter web dev
```

Open http://localhost:3000

### Demo mode (skip everything above — no backend, no keys)

```bash
NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm --filter web dev
```

---

## 7. Avatar System Setup

The avatar is a 3D character at each station that tracks people with its eyes and speaks
LLM synthesis via lip-synced TTS. See `docs/AVATAR.md` and `docs/AVATAR_PRD.md` for full specs.

**How it works**: Avatar platforms provide GLB files (3D models). Our code does everything else —
eye tracking (MediaPipe), gaze control (head bone rotation), lip sync (ARKit blend shapes),
emotions, idle animations. The GLB is the puppet; our code is the puppeteer. Zero lock-in
to any single avatar platform.

**Multi-source architecture**: Each archetype has a `glbSources` array with fallback:
Avaturn → MakeHuman → placeholder. Stations can prefer a specific provider or let it auto-resolve.

Placeholder avatars (colored boxes) ship in the repo and work immediately.

### 7a. Avaturn (recommended — realistic avatars)

Avaturn creates photorealistic 3D avatars from selfie photos or presets. Free tier, no limits
on avatar count or exports. GLBs include ARKit blend shapes (lip sync ready).

1. Sign up at https://developer.avaturn.me (free)
2. Create an application → copy your **API key / access token**
3. Reference: https://docs.avaturn.me/docs/integration/api/create-avatar-with-api/

```bash
export AVATURN_API_KEY=your_key_here
bash scripts/create-avaturn-avatars.sh
```

This generates 12 archetype avatars and saves them to `apps/web/public/avatars/avaturn/`.

**Create an avatar that looks like you** (for your own station):

Avaturn's primary flow is selfie → avatar. Upload a front-facing photo via their web UI
or API to get a GLB of yourself. Drop it in `apps/web/public/avatars/avaturn/` with
the appropriate archetype filename.

### 7b. MakeHuman + MPFB (open source — unlimited, no account needed)

Fully open source pipeline. Generate characters parametrically (sliders for age, build,
gender, ethnicity), add ARKit blend shapes via Blender addon, export GLB. Runs entirely
local — no API keys, no accounts, no limits.

**Install (one-time):**

```bash
# 1. Install MakeHuman
sudo apt install makehuman    # or download from https://static.makehumancommunity.org/makehuman.html

# 2. Install Blender (if not already)
sudo snap install blender --classic

# 3. Install MPFB addon for Blender
#    Download from https://static.makehumancommunity.org/mpfb.html
#    Blender → Edit → Preferences → Add-ons → Install → select the zip

# 4. Install ARKit Blendshape Helper addon for Blender
#    https://github.com/elijah-atkins/ARKitBlendshapeHelper
#    Same install process as MPFB
```

**Generate avatars:**

```bash
# Scripted pipeline (generates 12 archetypes)
bash scripts/create-makehuman-avatars.sh
```

Or manually: MakeHuman → design character → export to Blender → MPFB import →
ARKit Blendshape Helper → export GLB → save to `apps/web/public/avatars/makehuman/`.

**Note**: MakeHuman does NOT create avatars from photos. It's a parametric generator
(sliders). For photo-to-avatar, use Avaturn.

### 7c. ElevenLabs (text-to-speech for avatar speech)

The avatar speaks LLM synthesis output with lip-synced TTS. Free tier gives 10k characters/month.
ElevenLabs provides **voice only** — it pairs with any avatar GLB from any source above.

1. Go to https://elevenlabs.io/ → sign up (free tier works)
2. Click your profile icon → **Profile + API key** → copy the **API Key**
3. Reference: https://elevenlabs.io/docs/api-reference/text-to-speech

Add to your `apps/web/.env.local`:

```bash
NEXT_PUBLIC_ELEVENLABS_API_KEY=your_key_here
```

Verify: start the dev server, navigate to a quorum page — the avatar panel should show
and speak when synthesis updates come in.

### 7d. USB Webcam (for eye tracking + speaker direction)

The avatar uses the webcam for two things:
- **VisionTracker** (MediaPipe) — detects faces, drives avatar gaze direction
- **StereoAnalyzer** (Web Audio) — L/R mic energy → avatar head turn toward speaker

**Important**: built-in ThinkPad laptop mics are mono (beamformed). Stereo speaker
detection requires a USB webcam with a true stereo microphone.

Recommended: **Logitech C270** (~$25) or **C920** (~$60). Plug-and-play USB, no drivers on Linux.

After plugging in:

1. Open Chrome → `chrome://settings/content/camera` → select the USB webcam
2. Open Chrome → `chrome://settings/content/microphone` → select the USB webcam mic
3. When the app asks for camera/mic permission → allow

Verify: navigate to a quorum page → you should see the avatar's eyes follow you as you
move in front of the camera.

### 7e. Placeholder mode (no external accounts)

For testing without any avatar platform or ElevenLabs:

- Placeholder box avatars load by default as last fallback
- `MockProvider` handles speech silently (no ElevenLabs needed)
- Webcam eye tracking works with placeholders too

```bash
# Just start the frontend — avatar panel renders with placeholders
pnpm --filter web dev
```

### 7f. Reference: Open Source TalkingHead Library

[met4citizen/TalkingHead](https://github.com/met4citizen/TalkingHead) — MIT-licensed JavaScript
class for real-time lip sync with full-body 3D avatars. Supports GLB + Mixamo animations +
ElevenLabs TTS integration. Could replace or augment our IdleScene if we need more advanced
lip sync or animation blending in the future.

---

## 8. Verify

| Check | Command / URL | Expected |
|-------|---------------|----------|
| Python version | `python3.11 --version` | 3.11.x |
| Supabase CLI | `supabase --version` | >= 1.100 |
| Supabase running | http://127.0.0.1:54323 (Studio) | Table Editor → `events` has seed row |
| Supabase keys | `supabase status` | prints anon + service_role keys |
| Backend health | http://localhost:8000/health | `{"status": "ok"}` |
| Frontend loads | http://localhost:3000 | Event page renders |
| Azure auth | `az account show` | Shows dhp-dcri-prod-sub |
| Managed identity | POST to `/quorums/{id}/resolve` | Artifact generated (no 401) |
| Avatar renders | Navigate to quorum page | Avatar panel visible (Avaturn, MakeHuman, or placeholder) |
| Avaturn GLBs | `ls apps/web/public/avatars/avaturn/*.glb` | 12 files, each > 1MB |
| Eye tracking | Move in front of webcam | Avatar eyes follow you |
| Avatar speaks | Trigger synthesis update | Lip-synced speech (requires ElevenLabs key) |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `supabase start` fails | Ensure Docker is running: `docker ps`. On WSL, Docker Desktop must be open. |
| `supabase: command not found` | See step 2 — download binary to `/usr/local/bin/`. |
| Python 3.10 `X \| Y` syntax errors | You're using system Python. Use `python3.11` for the venv. |
| `ModuleNotFoundError: quorum_llm` | `pip install -e "../../packages/llm"` from `apps/api/`. |
| Backend can't connect to Supabase | `supabase status` to re-print keys. Check `.env` matches. |
| Frontend stuck in demo mode | Set `NEXT_PUBLIC_SUPABASE_URL` in `apps/web/.env.local`. |
| Azure OpenAI 401 | RBAC propagation can take 5 min. Check: `az role assignment list` (see 3d). Or fall back to API key. |
| `ImportError: azure-identity` | `pip install azure-identity` or `pip install quorum-llm[azure]`. |
