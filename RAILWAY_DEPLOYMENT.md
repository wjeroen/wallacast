# Deploying Wallacast to Railway (step by step)

This is a beginner-friendly guide for putting Wallacast online with [Railway](https://railway.app). Once it is live you can open it on your phone from anywhere and even install it like an app.

Wallacast runs as three separate pieces (Railway calls them "services") inside one project, all built from the same GitHub repo:

1. A **PostgreSQL database** (stores your accounts, content, and settings).
2. The **backend** (the Node.js API, built from the `backend/` folder).
3. The **frontend** (the React web app you actually look at, built from the `frontend/` folder).

You will set these up one at a time.

## Before you start

- Push this repo to your own GitHub account (Railway deploys from GitHub).
- Create a Railway account and sign in.

## Step 1: Create a Railway project

1. In Railway, create a new project.
2. Choose the option to deploy from a GitHub repo and pick your Wallacast repo.
3. Railway will create the project. Do not worry if the first build looks unhappy, you will configure things in the next steps.

## Step 2: Add the PostgreSQL database

1. Inside the project, add a new PostgreSQL database service (Railway has a ready-made Postgres option).
2. That is it for now. Railway provisions the database automatically and gives you a connection string you will reference later.

## Step 3: Deploy the backend

1. Add a service that deploys from your GitHub repo (or reuse the one Railway created in Step 1).
2. Open that service's settings and set the **Root Directory** to `backend`.
   - This matters because the `backend/` folder has a `Dockerfile`. Railway uses it to build the backend and it automatically installs FFmpeg, which Wallacast needs to make audio.
3. Add the environment variables from Step 5 below to this service.
4. Let it build and deploy.
5. Once it is running, give the backend a public URL. In the service's networking settings, generate a domain. Copy that URL, you will need it in a moment (this is your `BACKEND_URL`).

## Step 4: Deploy the frontend

1. Add another service from the same GitHub repo.
2. In its settings, set the **Root Directory** to `frontend`.
   - The `frontend/` folder uses Nixpacks (see `frontend/nixpacks.toml`). It builds the web app and serves it with `npx serve`.
3. Add the frontend environment variable from Step 5 below.
4. Let it build and deploy, then generate a public domain for it the same way you did for the backend.
5. This frontend URL is the one you open on your phone or browser. It is also your `FRONTEND_URL` for the backend.

## Step 5: Set the environment variables

Environment variables are just settings you type into each service's **Variables** tab. Add them, then let the service redeploy.

### Backend variables

- `DATABASE_URL` - the database connection string. The clean way to set this is to reference your PostgreSQL service (Railway lets one service point at another's variables), so it fills in automatically. You do not paste a password by hand.
- `FRONTEND_URL` - your frontend's public URL (for example `https://your-frontend.up.railway.app`). The backend uses this to allow requests from your web app (this is called CORS).
- `BACKEND_URL` - the backend's own public URL (for example `https://your-backend.up.railway.app`). It is used to build the links to your generated audio files.
- `JWT_SECRET` - any long random string, kept secret. It signs the short-lived (15-minute) login tokens and the private links to generated audio. Changing it logs nobody out: the 30-day sessions live in the database, and the app quietly gets new login tokens. It does change every private audio link, so audio that is open at that moment can stop loading until the item is opened again. If you leave it blank, the server makes a new random value on every start, which changes the audio links on every redeploy, so set it once and keep it.
- `ENCRYPTION_KEY` - a random key used to encrypt each user's AI provider API keys before they go into the database. It must be exactly 64 hex characters (32 bytes). Without it, stored keys fall back to plaintext, which you do not want in production.
- `DEMO_USERNAME` (optional) - the username of the shared read-only demo account behind the home page's "Try the demo" button. Defaults to `demo`. IMPORTANT: register that username yourself before promoting the instance (running the seed script does it for you), otherwise a stranger could claim it and control what demo visitors see. Populate the demo library with `cd backend && BASE_URL=https://your-backend-url DEMO_PASSWORD=... OPENAI_API_KEY=... DEEPINFRA_API_KEY=... ANTHROPIC_API_KEY=... npm run seed:demo` (the keys are used once for generation and then removed from the demo account).
- `INVITE_CODE` (optional) - when set, creating an account requires this exact code (the register form automatically shows an extra field on instances that need it). Leave unset to keep registration open.
- `RESEND_API_KEY` (optional) - enables the "Forgot password?" email flow via resend.com (the free tier is plenty). Without it, the reset form tells users to contact the operator instead.
- `EMAIL_FROM` (optional) - the sender for those reset emails, for example `Wallacast <you@yourdomain.com>` (requires verifying your domain at Resend). Defaults to Resend's shared onboarding sender, which works without any domain setup.
- `PORT` - set to `3001` (the port the backend listens on).

Tip for generating the secrets: on any machine with Node installed you can run
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
to print a fresh 64-character value. Use it for `ENCRYPTION_KEY`, and run it again to get a separate value for `JWT_SECRET`.

You do NOT set any OpenAI or other AI provider key here. See "How accounts and API keys work" below.

### Frontend variable

- `VITE_API_URL` - your backend's public URL with `/api` on the end (for example `https://your-backend.up.railway.app/api`).

## Step 6: Attach a volume for audio

Generated audio files live on disk at `/data/audio`, not inside the database. So the backend needs a persistent volume.

1. On the **backend** service, add a volume.
2. Set its mount path to `/data`.

If you skip this, your audio will vanish every time the backend redeploys, because a plain container's disk is wiped on each deploy.

## Step 7: Register and add your API keys

1. Open your frontend URL in a browser.
2. Register your first account right there in the app. Wallacast is multi-user, there is no admin password baked into the deployment.
3. Go to Settings and add your own AI provider API key(s) (OpenAI and others). Each account brings its own keys, and they are stored encrypted per account. There is no single global OpenAI key for the whole app.

## How accounts and API keys work

Wallacast is a multi-user app. After you deploy, you create your own account inside the app, and so does anyone else you invite. Every user pastes their own AI provider API keys into the in-app Settings page. Those keys are encrypted with your `ENCRYPTION_KEY` and saved to that user's row in the database. The server itself never holds one shared provider key.

## Password resets

There are two ways a lost password gets fixed, and both are safe to know publicly (the only secret is your `RESEND_API_KEY` value, which lives in Railway, never in this repo).

**1. Self-service by email (recommended).** Activate it once:

1. Create a free account at [resend.com](https://resend.com) (their free tier of 100 emails/day is far more than a reset flow needs).
2. Copy an API key from the Resend dashboard and set it as `RESEND_API_KEY` on the backend service in Railway.

That is the whole setup. From then on the login dropdown shows "Forgot password?". The user enters their username, gets an email with a one-hour, single-use reset link (only if their account has an email address), picks a new password, and every existing session for that account is logged out. Optionally set `EMAIL_FROM` (for example `Wallacast <you@yourdomain.com>`) after verifying your domain at Resend, otherwise emails come from Resend's shared onboarding sender, which works without any setup.

**2. Manual reset by the operator.** For accounts without an email address (email is optional at registration), you reset the password by hand:

1. Generate a password hash. From the `backend/` directory on any machine with the project installed:
   `node -e "require('bcrypt').hash('THE-NEW-PASSWORD', 10).then(h => console.log(h))"`
2. In your database tool (for example DbGate), run:
   `UPDATE users SET password_hash = '<the hash from step 1>' WHERE username = 'their-username';`
3. Log their old sessions out:
   `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = (SELECT id FROM users WHERE username = 'their-username');`

## Backups

Audio files can be regenerated, the database cannot. So dump the database now and then, and keep the file somewhere off Railway. The dump does not include the audio volume (`/data/audio`, 2.9 GB on 2026-10-22).

Railway's own backups (the Backups tab on the Postgres service) are documented without a plan limit, but answers from Railway staff on its forum say they need the Pro plan. Check the tab before you rely on it.

The Postgres public address (the TCP proxy) has been off on purpose since 2026-10-21, after Railway's security breach. So the dump runs inside the Postgres container, over `railway ssh`. This was tested on 2026-10-22 (a 58 MB dump, checksums matched):

1. Register an SSH key with Railway: `railway ssh keys add`. Railway's host key must be in your `known_hosts`. Remove the key again after the backup.
2. Make the dump inside the container (single quotes, so the container fills in its own `$PGUSER` and `$PGDATABASE`):
   `railway ssh -p <project id> -e production -s Postgres -- sh -c 'pg_dump -h localhost -U "$PGUSER" -d "$PGDATABASE" -Fc -f /tmp/x.dump'`
3. Copy it down: print the file as base64 between two marker lines, for example `railway ssh ... -- sh -c 'echo BEGIN; base64 /tmp/x.dump; echo END'`, keep the lines between the markers, and decode them locally (`base64 -d`).
4. Compare `sha256sum /tmp/x.dump` in the container with the SHA-256 of your local file.
5. Delete the copy in the container: `rm /tmp/x.dump`.

Not tested: `railway connect Postgres --tunnel-only` with a local `pg_dump` of version 17 or newer.

Restoring needs a connection to the database as well (`pg_restore --clean`), inside the container or through a tunnel. That has not been tested yet.

## HTTPS and installing as an app

Railway serves every public domain over HTTPS automatically, you do not configure certificates. This matters because Wallacast is a PWA (a website you can install like a phone app), and installing a PWA only works over HTTPS. So once your frontend is on its Railway domain, you can add it to your home screen.

## Troubleshooting

- **Backend returns 503 ("service starting up")**: the database is probably still initializing, give it a minute. If it never clears, check that `DATABASE_URL` is set on the backend (usually by referencing the Postgres service).
- **Audio stops loading right after a redeploy**: an item that was open still carries the old private audio link. Open the item again. If it happens on every redeploy, `JWT_SECRET` is not set: add a long random value.
- **Everyone gets logged out**: their sessions are gone from the `user_sessions` table (expired after 30 days, revoked by a password reset, or the database was replaced). A redeploy or a new `JWT_SECRET` logs nobody out.
- **Audio disappears after a redeploy**: the volume is missing or not mounted at `/data`. Add a volume on the backend service with mount path `/data`.
