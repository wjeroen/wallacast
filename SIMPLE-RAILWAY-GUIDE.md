# SIMPLE Railway Deployment - No Git Required!

Forget everything about git. Here's what you need to do:

## Step 1: Add Files to GitHub (2 minutes)

Railway needs 2 small config files. Add them directly on GitHub website:

### File 1: backend/nixpacks.toml

1. Go to: https://github.com/jeroenrawillems/readcast
2. Click on the `backend` folder
3. Click "Add file" → "Create new file"
4. Name it: `nixpacks.toml`
5. Paste this:

```toml
[phases.setup]
nixPkgs = ["nodejs_20", "postgresql"]

[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npm start"
```

6. Click "Commit new file"

### File 2: frontend/nixpacks.toml

1. Go back to: https://github.com/jeroenrawillems/readcast
2. Click on the `frontend` folder
3. Click "Add file" → "Create new file"
4. Name it: `nixpacks.toml`
5. Paste this:

```toml
[phases.setup]
nixPkgs = ["nodejs_20"]

[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npx serve -s dist -l 3000"
```

6. Click "Commit new file"

## Step 2: Deploy on Railway (5 minutes)

### A. Create PostgreSQL Database

1. Go to railway.app and login
2. Click "New Project"
3. Click "+ New" → "Database" → "PostgreSQL"
4. Wait 30 seconds

### B. Deploy Backend

1. Click "+ New" → "GitHub Repo" → select `readcast`
2. Click on the new service card
3. Click "Settings" tab (left sidebar)
   - Find "Root Directory"
   - Type: `backend`
   - Click "Save"
4. Click "Variables" tab (left sidebar)
   - Railway should auto-add database variables (POSTGRES_URL or DATABASE_*)
   - Click "+ New Variable" and add:
     - Name: `PORT` Value: `3001`
5. Wait for deployment (check "Deployments" tab)
6. Once deployed, go to "Settings" tab
   - Find "Networking" section
   - Copy the domain (like: backend-production-xxxx.up.railway.app)

### C. Deploy Frontend

1. Click "+ New" → "GitHub Repo" → select `readcast` again
2. Click on the new service card
3. Click "Settings" tab
   - Find "Root Directory"
   - Type: `frontend`
   - Click "Save"
4. Click "Variables" tab
   - Click "+ New Variable" and add:
     - Name: `VITE_API_URL`
     - Value: `https://[YOUR-BACKEND-URL]/api`
     - (Replace [YOUR-BACKEND-URL] with the URL from step B.6)
5. Click "Settings" tab
   - Find "Networking" section
   - Click "Generate Domain"
   - **COPY THIS URL** - this is your app!

### D. Fix CORS (Important!)

1. Go back to your **backend** service
2. Click "Variables" tab
3. Add one more variable:
   - Name: `FRONTEND_URL`
   - Value: `https://[YOUR-FRONTEND-URL]`
   - (Use the URL from step C.5)
4. Click "Redeploy" in the Deployments tab

## Step 3: Use Your App!

Open the frontend URL on your phone. Done! 🎉

## If It Still Doesn't Work

In Railway, check:
- Backend service has "Root Directory" = `backend`
- Frontend service has "Root Directory" = `frontend`
- All environment variables are set correctly
- Check the "Logs" tab for any errors

## Still Stuck?

Tell me:
1. Which step you're on
2. What error message you see
3. Screenshot if possible

I'll help you fix it!
