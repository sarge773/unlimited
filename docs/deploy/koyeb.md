# Deploy FreeLLMAPI to Koyeb (free, no credit card)

This guide covers deploying FreeLLMAPI to Koyeb's free tier with an encrypted
Hugging Face Dataset as the persistent backup target, then transferring your
local provider keys to the remote instance.

**Why Koyeb:** the only free, no-credit-card host that does not sleep on idle.
Every other free option (Hugging Face Spaces, Replit, Render free) sleeps after
15-60 minutes of inactivity, which adds a 30-60s cold-start penalty to the
first API call from your AI project each time.

**Why a backup target:** Koyeb's free tier has no persistent volume — the
SQLite database is wiped on every redeploy, restart, or crash. FreeLLMAPI has
built-in encrypted DB backup/restore (`server/src/lib/db-backup.ts`): on boot,
if the SQLite file is missing, it pulls the encrypted backup from a URL and
restores it before migrations run; while running, it uploads a fresh snapshot
on a timer. We point that at a free Hugging Face Dataset.

## Prerequisites

- **GitHub account** (free, no card) — Koyeb deploys from a GitHub repo you control.
- **Koyeb account** — sign up at https://www.koyeb.com with GitHub. No credit card.
- **Hugging Face account** (free, no card) — for the encrypted DB backup target.

## Step 1 — Fork the repo on GitHub

Koyeb deploys from a repo you control. The upstream `tashfeenahmed/freellmapi`
cannot be pushed to, so you need your own fork.

1. Open https://github.com/tashfeenahmed/freellmapi in a browser.
2. Click **Fork** (top right) → **Create fork**.
3. You now have `https://github.com/<your-github-username>/freellmapi`.

The `koyeb.dockerfile` in the repo root is a thin image that pulls the upstream
pre-built multi-arch image `ghcr.io/tashfeenahmed/freellmapi:latest`. This
skips the native `better-sqlite3` compilation step, which peaks around 600 MB
and would OOM-kill a build on Koyeb's 512 MB free tier.

## Step 2 — Create the Hugging Face Dataset (backup target)

This is where FreeLLMAPI ships its encrypted SQLite snapshot every few minutes
and pulls it back on every cold start.

1. Sign in at https://huggingface.co.
2. Click your avatar (top right) → **New dataset**.
3. Fill in:
   - **Namespace:** your account (default)
   - **Dataset name:** `freellmapi-db` (any name works; remember it for the env vars)
   - **License:** MIT
   - **Visibility:** **Private** (recommended — only your token can read it)
4. Click **Create dataset**.
5. Generate a HF access token: avatar → **Settings** → **Access Tokens** → **New token**:
   - **Name:** `freellmapi-backup`
   - **Type:** `Read and write` (or Fine-grained with write access to the dataset)
   - Click **Generate token** and copy the `hf_...` value. You will not be able
     to see it again after leaving the page.

## Step 3 — Generate the encryption keys

You need two independent 32-byte hex keys. Generate them with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice — once for `ENCRYPTION_KEY` (at-rest key storage), once for
`FREEAPI_DB_BACKUP_KEY` (the backup envelope). Store both somewhere safe;
they are the only thing protecting your provider keys.

## Step 4 — Create the Koyeb service

1. Sign into https://app.koyeb.com with your GitHub account.
2. Click **Create Service** → **GitHub** (authorize Koyeb to see your repos if prompted).
3. **Repository:** `<your-github-username>/freellmapi`.
4. **Branch:** `main`.
5. **Build settings:**
   - **Build type:** Dockerfile
   - **Dockerfile path:** `koyeb.dockerfile`
   - Leave "Build command" empty — the Dockerfile handles it.
6. **Service type:** Web Service.
7. **Instance:** Free (512 MB RAM, 0.1 vCPU, 1 instance) — the default; no card.
8. **Port:** `3001` (HTTP, Public). Koyeb auto-detects from `EXPOSE`, but confirm.
9. **Environment variables:** click **Raw editor** and paste (replace the
   placeholders with your real values from Steps 2 and 3):

   ```
   ENCRYPTION_KEY=<64-char-hex from Step 3>
   HOST=0.0.0.0
   PORT=3001
   NODE_ENV=production
   FREEAPI_DB_BACKUP_URL=https://huggingface.co/datasets/<your-hf-username>/<dataset-name>/resolve/main/freeapi.db.backup
   FREEAPI_DB_BACKUP_TOKEN=<hf_... token from Step 2>
   FREEAPI_DB_BACKUP_KEY=<different 64-char-hex from Step 3>
   FREEAPI_DB_BACKUP_INTERVAL_MS=300000
   FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true
   REQUEST_ANALYTICS_RETENTION_DAYS=30
   REQUEST_ANALYTICS_MAX_ROWS=20000
   ```

   Delete the `https://{{ KOYEB_PUBLIC_DOMAIN }}/` placeholder line Koyeb
   pre-fills in the Raw editor — it is not an env var.

10. **Service name:** `freellmapi` (or whatever you like) → click **Deploy**.

Koyeb pulls the image in 30-60s (no build). The service URL appears at the top
of the service page once healthy: `https://freellmapi-<your-org>.koyeb.app`.

## Step 5 — First-run dashboard setup

The first time the service boots, the SQLite DB is empty (no backup exists
yet), so FreeLLMAPI starts fresh. Because the dashboard is internet-reachable,
the first account requires a one-time setup code.

1. Open `https://freellmapi-<your-org>.koyeb.app` in a browser.
2. In Koyeb: service page → **Logs** tab → find the line near startup:
   `First-run setup code: XXXXX-XXXXX` (only printed while no account exists).
   - If you do not see it, the logs may have scrolled past startup. Click
     **Redeploy** on the service page and watch the Logs tab live as it boots.
3. Back in the browser: enter the setup code + an email + a **strong**
   password (16+ chars — the dashboard is public on the internet and guards
   all your provider keys) → **Create your account**.
4. Go to the **Keys** page and add your provider API keys (Groq, Google,
   OpenRouter, etc. — all free, no card). Or use the key-transfer flow below
   to copy keys from a local install.
5. Go to the **Fallback Chain** page and reorder models to taste.
6. Copy the **unified API key** from the **Keys** page header (`freellmapi-...`)
   — this is the single bearer token your AI project uses.

## Step 6 — Transfer local keys to the Koyeb instance

If you already run FreeLLMAPI locally with provider keys configured, you can
copy them to the Koyeb instance instead of re-entering each one by hand. The
flow uses the dashboard's built-in JSON export + import endpoints.

### 6a — Export keys from the local instance

1. Start the local server if it is not already running:
   ```bash
   npm run dev      # dev: server on :3001, dashboard on :5173
   # or, for a production build:
   npm run build && node server/dist/index.js
   ```
2. Open the local dashboard (http://localhost:5173 in dev, http://localhost:3001
   in production) and log in.
3. Go to the **Keys** page → click **Export** → choose **JSON** format.
   This downloads `freellmapi-keys.json` with all your keys decrypted.

   The export endpoint is `GET /api/keys/export?format=json`
   (`server/src/routes/keys.ts:222`). It returns:
   ```json
   {
     "version": 1,
     "exportedAt": "2026-07-25T00:00:00.000Z",
     "source": "freellmapi",
     "keys": [
       { "platform": "groq", "key": "gsk_...", "label": "main" },
       { "platform": "google", "key": "AIza...", "label": "" }
     ]
   }
   ```

   Other formats: `?format=env` for a `.env` file, `?format=csv` for CSV.
   Use JSON for round-trip-safe re-import.

### 6b — Import keys to the Koyeb instance

1. Open the Koyeb dashboard at `https://freellmapi-<your-org>.koyeb.app` and
   log in with the account from Step 5.
2. Go to the **Keys** page → click **Import**.
3. Upload the `freellmapi-keys.json` file from Step 6a. The dashboard preview
   shows each key with a checkbox; select the ones you want and confirm.
4. The import endpoint is `POST /api/keys/import-selected`
   (`server/src/routes/keys.ts:665`). It skips duplicates (same key value
   already present) and rejects custom providers (those need a base URL — add
   them manually via **Add custom provider**).

The Koyeb instance now has the same provider keys as your local install. The
next encrypted DB backup (within `FREEAPI_DB_BACKUP_INTERVAL_MS`, default 5
minutes) ships them to your HF Dataset, so they survive future restarts.

## Step 7 — Point your AI project at the API

Your deployed base URL is `https://freellmapi-<your-org>.koyeb.app/v1`. Use
the unified key from Step 5 as the API key. Works with any OpenAI-compatible
client (OpenAI SDK, LangChain, LlamaIndex, Aider, Continue, Cursor, etc.).

```python
from openai import OpenAI
client = OpenAI(
    base_url="https://freellmapi-<your-org>.koyeb.app/v1",
    api_key="freellmapi-your-unified-key",
)
resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "hi"}],
)
print(resp.choices[0].message.content)
```

For Anthropic / Claude Code (the server also speaks `/v1/messages`):

```bash
export ANTHROPIC_BASE_URL=https://freellmapi-<your-org>.koyeb.app
export ANTHROPIC_AUTH_TOKEN=freellmapi-your-unified-key
claude
```

## How persistence works across restarts

- Every `FREEAPI_DB_BACKUP_INTERVAL_MS` (default 300000 = 5 minutes),
  FreeLLMAPI uploads an encrypted snapshot of `freeapi.db` to the HF Dataset URL.
- On any cold start (redeploy, restart, crash), if the local DB file is missing,
  it downloads the encrypted snapshot from HF, decrypts it with
  `FREEAPI_DB_BACKUP_KEY`, and runs migrations against it.
- Worst-case data loss: up to 5 minutes of changes (request logs, key
  additions) — provider keys and routing settings always survive.
- The HF Dataset is private and the snapshot is encrypted with a 32-byte key,
  so even if the URL leaks, the DB is unreadable without
  `FREEAPI_DB_BACKUP_KEY`.

## Keeping it free

- Stay within 1 service on Koyeb's free tier. A second service or a paid
  instance triggers the payment-method requirement.
- Keep `REQUEST_ANALYTICS_MAX_ROWS` low (20000 is plenty for personal use) so
  the DB snapshot stays small and backup/restore is fast.
- If you stop using it: delete the Koyeb service and the HF Dataset. No charge
  either way.

## Why not the other free hosts

| Host | Why not |
|---|---|
| Hugging Face Spaces | Sleeps when idle → 30-60s cold start on every API call after inactivity. Bad for an AI API. |
| Render free | Sleeps after 15 min idle. Same cold-start problem. |
| Replit free | Sleeps. Ephemeral disk. Tighter resource limits than Koyeb. |
| Vercel / Netlify / Cloudflare Workers | Serverless — no long-running process, no SQLite. Fundamentally incompatible. |
| Oracle / GCP / AWS free tiers | Require a credit card at signup for verification. |

## Files in this deploy setup

- `koyeb.dockerfile` — thin image that pulls
  `ghcr.io/tashfeenahmed/freellmapi:latest` and sets env defaults
  (`HOST=0.0.0.0`, SSRF guard on). Committed to the repo so Koyeb can find it.
- `docs/deploy/koyeb.md` — this document.
- `koyeb.env.example` (gitignored) — template for the env vars with generated
  keys. Never commit it; it contains secrets.

## Security notes

- The dashboard is public on the internet at the Koyeb URL. Use a strong
  admin password (16+ chars) and treat the dashboard like a cloud key vault.
- `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true` blocks custom-provider base URLs
  that point at private/LAN/metadata addresses, so an attacker who gets
  dashboard access cannot use custom providers for SSRF. This is the
  recommended setting for any internet-reachable install.
- Rotate the HF token periodically at
  https://huggingface.co/settings/tokens. Update the
  `FREEAPI_DB_BACKUP_TOKEN` env var in Koyeb and redeploy.
- If the `ENCRYPTION_KEY` or `FREEAPI_DB_BACKUP_KEY` is leaked, regenerate
  it, update the Koyeb env vars, redeploy, and re-add your provider keys
  (the old encrypted DB is unreadable with the new key).