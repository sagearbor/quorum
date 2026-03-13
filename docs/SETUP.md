# SETUP.md — Manual Setup Walkthrough

Everything you need to do by hand to get Quorum running. Checklist style — work top to bottom.

---

## 0. Machine Status (DCRI-PF4YNVSH / WSL Ubuntu 22.04)

| Tool | Required | Status | Action |
|------|----------|--------|--------|
| **Node.js** | >= 18 | v22.16.0 | Done |
| **pnpm** | >= 9 | 9.15.9 | Done |
| **Python** | >= 3.11 | 3.10.12 | **Upgrade needed** (see below) |
| **Docker** | Desktop or Engine | 28.4.0 | Done |
| **Supabase CLI** | >= 1.100 | not installed | **Install needed** (see below) |
| **Azure CLI** | latest | 2.77.0 | Done (upgrade available: `az upgrade`) |
| **Azure login** | logged in | dhp-dcri-prod-sub | Done |

---

## 1. Upgrade Python to 3.11+

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

---

## 2. Install Supabase CLI

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

---

## 3. Accounts & Services to Set Up

These are the external accounts/resources you need. Check off as you go.

### 3a. Supabase (local — no account needed)

Supabase runs entirely local via Docker. No signup required for dev.

```bash
# From repo root — pulls Docker images on first run (~2-3 min)
supabase start
```

This prints your local keys:

```
API URL: http://127.0.0.1:54321
anon key: eyJ...        ← copy this
service_role key: eyJ... ← copy this
```

Save these — you'll paste them into `.env` files in step 5.

Migrations and seed data (`supabase/seed.sql`) run automatically. Verify at http://127.0.0.1:54323 (Studio) → Table Editor → `events` table should have the seed row.

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

### 3c. Azure OpenAI Resource

You're already logged into `dhp-dcri-prod-sub`. You need an Azure OpenAI resource with two model deployments.

**Check if a resource already exists:**

```bash
az cognitiveservices account list --query "[?kind=='OpenAI'].{name:name, endpoint:properties.endpoint}" -o table
```

**If you need to create one:**

1. Go to https://portal.azure.com → search "Azure OpenAI" → **Create**
2. Select subscription `dhp-dcri-prod-sub`, pick a resource group and region
3. Pricing tier: Standard S0

**Create model deployments** (or verify existing):

```bash
# List existing deployments
az cognitiveservices account deployment list \
  --name YOUR-RESOURCE-NAME \
  --resource-group YOUR-RG \
  -o table
```

You need two deployments:

| Deployment name | Model | Used for |
|----------------|-------|----------|
| `gpt-4o-mini` | gpt-4o-mini | Tier 2: conflict detection |
| `gpt-4o` | gpt-4o | Tier 3: artifact synthesis |

Create via portal: Resource → **Model deployments** → **Manage Deployments** → **+ Create new deployment**
Or via CLI:

```bash
az cognitiveservices account deployment create \
  --name YOUR-RESOURCE-NAME \
  --resource-group YOUR-RG \
  --deployment-name gpt-4o-mini \
  --model-name gpt-4o-mini \
  --model-version "2024-07-18" \
  --model-format OpenAI \
  --sku-capacity 10 \
  --sku-name Standard
```

**Copy the endpoint** (e.g., `https://your-resource.openai.azure.com/`) — you'll need it for `.env`.

### 3d. Azure RBAC for Managed Identity

Managed identity is the default auth. Your Azure AD user needs the `Cognitive Services OpenAI User` role on the Azure OpenAI resource.

**Check if you already have the role:**

```bash
az role assignment list \
  --assignee $(az ad signed-in-user show --query id -o tsv) \
  --scope $(az cognitiveservices account show --name YOUR-RESOURCE-NAME --resource-group YOUR-RG --query id -o tsv) \
  -o table
```

**Assign it if missing:**

```bash
az role assignment create \
  --assignee $(az ad signed-in-user show --query id -o tsv) \
  --role "Cognitive Services OpenAI User" \
  --scope $(az cognitiveservices account show --name YOUR-RESOURCE-NAME --resource-group YOUR-RG --query id -o tsv)
```

> Role assignment can take **up to 5 minutes** to propagate. If you get 401s right after, wait and retry.

**Reference**: https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/managed-identity

**Fallback — API key** (if RBAC isn't available):

```bash
# Get keys
az cognitiveservices account keys list \
  --name YOUR-RESOURCE-NAME \
  --resource-group YOUR-RG \
  -o table
```

Then set `AZURE_OPENAI_USE_MANAGED_IDENTITY=false` and `AZURE_OPENAI_KEY=<key>` in `.env`.

---

## 4. Python Backend Setup

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

---

## 5. Environment Files

### Repo root: `.env` (backend, loaded by python-dotenv)

```bash
cp .env.example .env
```

Fill in:

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key from `supabase status`>
SUPABASE_SERVICE_KEY=<service_role key from `supabase status`>

AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_T2=gpt-4o-mini
AZURE_OPENAI_DEPLOYMENT_T3=gpt-4o
AZURE_OPENAI_USE_MANAGED_IDENTITY=true

QUORUM_LLM_PROVIDER=azure
NEXTAUTH_SECRET=<generate: openssl rand -base64 32>
```

### Frontend: `apps/web/.env.local`

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key>
NEXT_PUBLIC_API_URL=http://localhost:8000
```

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

Placeholder avatars (colored boxes) ship in the repo and work immediately. The steps below
replace them with real avatars and enable speech.

### 7a. Ready Player Me (real 3D avatars)

Replaces the placeholder box avatars with full-body humanoid GLBs.

1. Go to https://readyplayer.me/ → sign up (free)
2. Go to https://studio.readyplayer.me/ → create an application
3. Go to your app → **Settings** → copy your **App ID**
4. Go to **API Keys** → create one → copy the **API Key**
5. Reference: https://docs.readyplayer.me/ready-player-me/api-reference

Set env vars and run the script:

```bash
export RPM_API_KEY=your_key_here
export RPM_APP_ID=your_app_id_here
bash scripts/create-rpm-avatars.sh
```

This creates 12 archetype avatars via the RPM API and saves them to `apps/web/public/avatars/`.
Any that fail fall back to placeholders automatically.

Verify:

```bash
ls -la apps/web/public/avatars/*.glb
# Should see 12 files, each > 1MB (real avatars) vs ~2KB (placeholders)
```

> **Alternative**: manually create avatars at https://readyplayer.me/avatar and download
> full-body GLBs with `morphTargets=ARKit` (needed for lip sync). Drop them in
> `apps/web/public/avatars/` using filenames from `apps/web/public/avatars/README.md`.

### 7b. ElevenLabs (text-to-speech for avatar speech)

The avatar speaks LLM synthesis output with lip-synced TTS. Free tier gives 10k characters/month.

1. Go to https://elevenlabs.io/ → sign up (free tier works)
2. Click your profile icon → **Profile + API key** → copy the **API Key**
3. Reference: https://elevenlabs.io/docs/api-reference/text-to-speech

Add to your `apps/web/.env.local`:

```bash
NEXT_PUBLIC_ELEVENLABS_API_KEY=your_key_here
```

Verify: start the dev server, navigate to a quorum page — the avatar panel should show
and speak when synthesis updates come in.

### 7c. USB Webcam (for eye tracking + speaker direction)

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

### 7d. Avatar without external accounts (placeholder mode)

For testing without RPM or ElevenLabs:

- Placeholder box avatars load by default (no RPM account needed)
- `MockProvider` handles speech silently (no ElevenLabs needed)
- Webcam eye tracking works with placeholders too

```bash
# Just start the frontend — avatar panel renders with placeholders
pnpm --filter web dev
```

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
| Avatar renders | Navigate to quorum page | Avatar panel visible (placeholder or real) |
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
