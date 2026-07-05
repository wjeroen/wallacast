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
- `JWT_SECRET` - any long random string. It signs the login tokens. If you leave it blank, everyone gets logged out every time you redeploy, so set it once and keep it.
- `ENCRYPTION_KEY` - a random key used to encrypt each user's AI provider API keys before they go into the database. It must be exactly 64 hex characters (32 bytes). Without it, stored keys fall back to plaintext, which you do not want in production.
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

## HTTPS and installing as an app

Railway serves every public domain over HTTPS automatically, you do not configure certificates. This matters because Wallacast is a PWA (a website you can install like a phone app), and installing a PWA only works over HTTPS. So once your frontend is on its Railway domain, you can add it to your home screen.

## Troubleshooting

- **Backend returns 503 ("service starting up")**: the database is probably still initializing, give it a minute. If it never clears, check that `DATABASE_URL` is set on the backend (usually by referencing the Postgres service).
- **Everyone gets logged out after a redeploy**: `JWT_SECRET` is not set. Add a long random value and it will stop happening.
- **Audio disappears after a redeploy**: the volume is missing or not mounted at `/data`. Add a volume on the backend service with mount path `/data`.
