#!/bin/bash
# Quick Railway Deployment Script for Readcast

echo "🚀 Creating Railway deployment files..."

# Create backend nixpacks.toml
cat > backend/nixpacks.toml << 'EOF'
# Nixpacks configuration for backend
[phases.setup]
nixPkgs = ["nodejs_20", "postgresql"]

[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npm start"
EOF

# Create frontend nixpacks.toml
cat > frontend/nixpacks.toml << 'EOF'
# Nixpacks configuration for frontend
[phases.setup]
nixPkgs = ["nodejs_20"]

[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npx serve -s dist -l 3000"
EOF

echo "✅ Files created!"
echo ""
echo "Now go to GitHub and manually upload these files:"
echo "1. Go to: https://github.com/jeroenrawillems/readcast"
echo "2. Click on 'backend' folder → 'Add file' → 'Create new file'"
echo "3. Name it: nixpacks.toml"
echo "4. Copy contents from backend/nixpacks.toml above"
echo "5. Repeat for frontend/nixpacks.toml"
echo ""
echo "Or just push these changes using:"
echo "  git add backend/nixpacks.toml frontend/nixpacks.toml"
echo "  git commit -m 'Add Railway deployment config'"
echo "  git push"
