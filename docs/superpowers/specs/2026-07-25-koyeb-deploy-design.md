# FreeLLMAPI on Koyeb — Deployment Guide

**Goal:** Run FreeLLMAPI free, no credit card, no local hardware, on a persistent public HTTPS URL your AI project can call.

**Host:** Koyeb free tier (1 always-on service, 512 MB RAM, no credit card at signup)
**DB persistence strategy:** encrypted SQLite backup to a free Hugging Face Dataset, restored on every cold boot

## Why this setup

- **Koyeb** is the only free, no-credit-card host that does **not sleep** on idle. Every other free option (HF Spaces, Replit, Render free) sleeps after 15-60 min of inactivity, which means a 30-60s cold-start penalty on the first API call from your AI project each time.
- **No Docker build on Koyeb.** We deploy the upstream pre-built multi-arch image `ghcr.io/tashfeenahmed/freellmapi:latest`. This sidesteps the 512 MB RAM cap — `better-sqlite3` native compilation via `node-gyp` peaks around 600 MB and would OOM-kill a build on the free tier.
- **Ephemeral disk workaround.** Koyeb's free tier has no persistent volume. FreeLLMAPI has built-in encrypted DB backup/restore (`server/src/lib/db-backup.ts`, `.env.example:119-126`): on boot, if the SQLite file is missing, it pulls the encrypted backup from a URL and restores it before migrations run; while running, it uploads a fresh snapshot every 5 minutes. We point that at a free Hugging Face Dataset.

## Prerequisites (one-time, ~10 minutes)

1. **GitHub account** (free, no card) — needed because Koyeb deploys from a GitHub repo.
2. **Koyeb account** — sign up at https://www.koyeb.com with your GitHub account. No credit card.
3. **Hugging Face account** (free, no card) — for the encrypted DB backup target. Sign up at https://huggingface.co.

## Step 1 — Fork the repo on GitHub

Koyeb deploys from a repo you control. The local `origin` points to the upstream `tashfeenahmed/freellmapi`, which you can't push to.

1. Open https://github.com/tashfeenahmed/freellmapi in a browser.
2. Click **Fork** (top right) → **Create fork**. You now have `https://github.com/<your-github-username>/freellmapi`.

The `koyeb.dockerfile` and `koyeb.env.example` files in this directory stay local — Koyeb doesn't need them in the repo. You'll paste their contents into the Koyeb dashboard.

## Step 2 — Create the Hugging Face Dataset (encrypted DB backup target)

This is where FreeLLMAPI will ship its encrypted SQLite snapshot every 5 minutes and pull it back on every cold start.

1. Go to https://huggingface.co/login and sign in.
2. Click your avatar (top right) → **New dataset**.
3. **Name:** `freellmapi-db` (so the URL becomes `https://huggingface.co/datasets/<your-hf-username>/freellmapi-db`)
4. **License:** MIT
5. **Visibility:** Private (recommended — only you can read it, using your token)
6. Click **Create dataset**.
7. Generate a HF access token: avatar → **Settings** → **Access Tokens** → **New token**:
   - **Name:** `freellmapi-backup`
   - **Type:** `Read and write` (or "Fine-grained" with write access to `freellmapi-db`)
   - Click **Generate token**, copy the value (`hf_...`) — you'll paste it into Koyeb.

## Step 3 — Create the Koyeb service

1. Sign into https://app.koyeb.com with your GitHub account.
2. Click **Create Service** → **GitHub** (authorize Koyeb to see your repos if prompted).
3. **Repository:** select `<your-github-username>/freellmapi`.
4. **Branch:** `main`
5. **Build settings:**
   - **Build type:** Dockerfile
   - **Dockerfile path:** `koyeb.dockerfile` (this is the thin file that pulls the upstream image and adds env defaults — not the repo's main Dockerfile, which would need ~600 MB to compile `better-sqlite3`)
   - Leave "Build command" empty — Dockerfile handles it.
6. **Service type:** Web Service
7. **Instance:** Free (512 MB RAM, 0.1 vCPU, 1 instance) — the default; no credit card needed.
8. **Port:** 3001 (Koyeb auto-detects from `EXPOSE`, but confirm it's 3001, HTTP, Public).
9. **Environment variables:** click **Add variable** and paste each of these (values from `koyeb.env.example`, with the HF placeholders filled in):

   | Key | Value |
   |---|---|
   | `ENCRYPTION_KEY` | `ae27bc12ffbc2eedeef45a6c622de53624c651585c6593e4e1af879a75bdd670` |
   | `HOST` | `0.0.0.0` |
   | `PORT` | `3001` |
   | `NODE_ENV` | `production` |
   | `FREEAPI_DB_BACKUP_URL` | `https://huggingface.co/datasets/<your-hf-username>/freellmapi-db/resolve/main/freeapi.db.backup` (replace `<your-hf-username>`) |
   | `FREEAPI_DB_BACKUP_TOKEN` | `hf_...` (your HF token from Step 2) |
   | `FREEAPI_DB_BACKUP_KEY` | `377d8c316cdba4598a0da3190a336299e0c14a0da6389a784191e6dab66606b3` |
   | `FREEAPI_DB_BACKUP_INTERVAL_MS` | `300000` |
   | `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS` | `true` |
   | `REQUEST_ANALYTICS_RETENTION_DAYS` | `30` |
   | `REQUEST_ANALYTICS_MAX_ROWS` | `20000` |

10. **Service name:** `freellmapi` (or whatever you like)
11. Click **Deploy**.

Koyeb pulls the image in 30-60s (no build). The service URL will be `https://freellmapi-<your-org>.koyeb.app` (shown at the top of the service page once healthy).

## Step 4 — First-run dashboard setup

The first time the service boots, the SQLite DB is empty (no backup exists yet), so FreeLLMAPI starts fresh.

1. Open `https://freellmapi-<your-org>.koyeb.app` in a browser.
2. Because the dashboard is now internet-reachable, FreeLLMAPI requires a **one-time setup code** printed in the server logs to create the first admin account.
3. In Koyeb: service page → **Logs** tab → find the line near startup that says something like:
   `First-run setup code: XXXXX-XXXXX` (only printed while no account exists).
4. Back in the browser: enter that code + an email + password to create the admin account.
5. Once logged in, go to the **Keys** page and add your provider API keys (Groq, Google, OpenRouter, etc. — all free, no card).
6. Go to the **Fallback Chain** page and reorder models to taste.
7. Grab the **unified API key** from the **Keys** page header (`freellmapi-...`) — this is the single bearer token your AI project uses.

## Step 5 — Point your AI project at the API

Your deployed base URL is `https://freellmapi-<your-org>.koyeb.app/v1`. Use the unified key from Step 4 as the API key. Works with any OpenAI-compatible client (OpenAI SDK, LangChain, LlamaIndex, Aider, Continue, Cursor, etc.).

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

## How persistence works across restarts

- Every 5 minutes, FreeLLMAPI uploads an encrypted snapshot of `freeapi.db` to the HF Dataset URL.
- On any cold start (redeploy, restart, crash), if the local DB file is missing, it downloads the encrypted snapshot from HF, decrypts it with `FREEAPI_DB_BACKUP_KEY`, and runs migrations against it.
- Worst-case data loss: up to 5 minutes of changes (request logs, key additions) — provider keys and routing settings always survive.
- The HF Dataset is private and the snapshot is encrypted with a 32-byte key, so even if the URL leaks, the DB is unreadable without `FREEAPI_DB_BACKUP_KEY`.

## Keeping it free

- Stay within 1 service on Koyeb's free tier. A second service or a paid instance triggers the payment-method requirement.
- Keep `REQUEST_ANALYTICS_MAX_ROWS` low (20000 is plenty for personal use) so the DB snapshot stays small and backup/restore is fast.
- If you stop using it: delete the Koyeb service and the HF Dataset. No charge either way.

## Files added by this deploy setup

- `koyeb.dockerfile` — thin image that pulls `ghcr.io/tashfeenahmed/freellmapi:latest` and sets env defaults. Committed to the repo so Koyeb can find it.
- `koyeb.env.example` — template for the env vars (gitignored, contains secrets).
- `docs/superpowers/specs/2026-07-25-koyeb-deploy-design.md` — this document.

## Why not the other free hosts

| Host | Why not |
|---|---|
| Hugging Face Spaces | Sleeps when idle → 30-60s cold start on every API call after inactivity. Bad for an AI API. |
| Render free | Sleeps after 15 min idle. Same cold-start problem. |
| Replit free | Sleeps. Ephemeral disk. Tighter resource limits than Koyeb. |
| Vercel / Netlify / Cloudflare Workers | Serverless — no long-running process, no SQLite. Fundamentally incompatible. |
| Oracle / GCP / AWS free tiers | Require a credit card at signup for verification. Disqualified per your constraint. |

Koyeb is the only option that is simultaneously free at signup, no card, doesn't sleep, and can run a long-running Node process with a real HTTP listener.