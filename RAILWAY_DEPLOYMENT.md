# Deploying Readcast to Railway

This guide will help you deploy Readcast to Railway.app so you can access it from your phone anywhere!

## What You'll Deploy

- **Backend Service** (Node.js API)
- **Frontend Service** (React Web App)
- **PostgreSQL Database**

## Step-by-Step Instructions

### 1. Create a Railway Account

1. Go to [railway.app](https://railway.app)
2. Click "Start a New Project"
3. Sign up with GitHub (this is required)

### 2. Create a New Project

1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Connect your GitHub account if not already connected
4. Select your `readcast` repository

### 3. Deploy the Database

1. In your Railway project, click "+ New"
2. Select "Database" → "PostgreSQL"
3. Railway will automatically create and provision the database
4. **Write down the database credentials** (or leave the tab open - you'll need them)

### 4. Deploy the Backend

1. Click "+ New" → "GitHub Repo" → Select `readcast`
2. Railway will try to deploy but fail (this is expected!)
3. Click on the service → Go to "Settings"
4. Set **Root Directory** to: `backend`
5. **Connect the Database** (Most Important Step!):
   - Go to "Variables" tab
   - Railway usually auto-connects services, so you should already see variables like:
     - `DATABASE_URL` or `POSTGRES_URL` (full connection string)
     - OR individual variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
   - **If you DON'T see these**, you need to connect the services:
     - Option A: Look for a "Reference" or "Connect" button near "+ New Variable"
     - Option B: Go to your PostgreSQL service, copy the DATABASE_URL, and add it to backend variables
   - **Good news**: The backend automatically detects Railway's database variables! No manual copying needed.

6. Add these **required** environment variables:
   - `PORT` = `3001`
   - `AUTH_USERNAME` = (your choice, e.g., "admin")
   - `AUTH_PASSWORD` = (your choice, use a strong password)
   - `OPENAI_API_KEY` = (required for transcription and TTS)

   **Important**: The app now uses HTTP Basic Auth to protect your API. Your browser will prompt you for these credentials.

7. Click "Deploy" or wait for automatic redeployment
8. Once deployed, go to "Settings" → "Networking" → Click "Generate Domain" if not already created
9. Copy the **public domain URL** (e.g., `backend-production-xxxx.up.railway.app`)

### 5. Deploy the Frontend

1. Click "+ New" → "GitHub Repo" → Select `readcast` again
2. Click on the new service → Go to "Settings"
3. Set **Root Directory** to: `frontend`
4. Go to "Variables" tab and add:
   - `VITE_API_URL` = `https://[your-backend-url].up.railway.app/api`

   **Replace** `[your-backend-url]` with the backend URL from step 4!

5. Click "Deploy" or wait for redeployment
6. Once deployed, go to "Settings" → "Networking" → Click "Generate Domain"
7. **Copy your frontend URL!** This is what you'll visit on your phone

### 6. Update Backend CORS (Important!)

1. Go back to your backend service
2. Add one more environment variable:
   - `FRONTEND_URL` = `https://[your-frontend-url].up.railway.app`

Now the backend knows to accept requests from your frontend!

### 7. Test It!

1. Open the frontend URL on your phone's browser
2. You should see the Readcast app!
3. Try adding content, subscribing to podcasts, etc.

## Quick Reference - Environment Variables

### Backend Variables
```
# Database connection (Railway auto-provides these)
DATABASE_URL=(auto-provided by Railway when you connect the PostgreSQL service)
# OR individual variables:
PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD=(auto-provided by Railway)

# Manual configuration (only needed if Railway doesn't auto-connect)
DB_HOST=(from PostgreSQL service)
DB_PORT=(from PostgreSQL service)
DB_NAME=(from PostgreSQL service)
DB_USER=(from PostgreSQL service)
DB_PASSWORD=(from PostgreSQL service)

# Required
PORT=3001
FRONTEND_URL=https://your-frontend-url.up.railway.app
AUTH_USERNAME=admin (or your choice)
AUTH_PASSWORD=your-secure-password
OPENAI_API_KEY=sk-proj-... (required for transcription and TTS)
```

**Note**: The backend automatically installs ffmpeg via `nixpacks.toml` for audio processing. This is required for podcast transcription and article TTS to work correctly.

### Frontend Variables
```
VITE_API_URL=https://your-backend-url.up.railway.app/api
```

## Troubleshooting

### "Cannot connect to database" or "ECONNREFUSED 127.0.0.1:5432"
This means the backend can't find the PostgreSQL service. Fix it:
- **Check Variables tab** in your backend service - you should see `DATABASE_URL` or `PG*` variables
- If you DON'T see them, the services aren't connected:
  - Go to backend Variables tab → look for "Add Reference" or "Connect" option
  - OR go to PostgreSQL service → copy DATABASE_URL → paste it in backend Variables
- **After adding variables**, click "Redeploy" on the backend service
- The backend now auto-detects Railway's standard PostgreSQL variables, so once they're present it should work!

### "API requests failing"
- Check that `VITE_API_URL` in frontend points to your backend URL
- Make sure backend URL includes `/api` at the end
- Check backend logs for CORS errors

### "Build failed"
- Make sure Root Directory is set correctly (`backend` or `frontend`)
- Check the build logs for specific errors
- Make sure `nixpacks.toml` files are present

### Backend keeps crashing
- Check that database connection is working
- Railway free tier databases might sleep - wait a minute and retry
- Check environment variables are all set

### "Cannot find ffprobe" or ffmpeg errors
- Make sure the backend service Root Directory is set to `backend` (Settings → Root Directory)
- The `nixpacks.toml` file in the backend directory automatically installs ffmpeg
- If Railway skipped the nixpacks.toml, redeploy the backend service after confirming Root Directory is `backend`
- Check the build logs - you should see ffmpeg being installed during the build phase

## Using Railway CLI (Advanced)

If you want to use the command line instead:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link your project
railway link

# Deploy backend
cd backend
railway up

# Deploy frontend
cd ../frontend
railway up
```

## Free Tier Limits

Railway free tier includes:
- $5 credit per month
- Should be enough for light personal use
- Backend, frontend, and database each count toward usage

If you run out of credits, the services will stop until next month.

## Next Steps

Once deployed, you can:
- Add the URL to your phone's home screen (works like an app!)
- Share the URL with other devices
- Consider upgrading Railway for more credits if needed

## Support

If you get stuck:
- Check [Railway documentation](https://docs.railway.app)
- Check the Railway dashboard logs for error messages
- Make sure your GitHub repository is up to date
