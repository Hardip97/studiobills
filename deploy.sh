#!/bin/bash

# ============================================================
# StudioBills – GitHub + Vercel Deployment Script
# Run this once from Terminal to go live!
# ============================================================

GITHUB_TOKEN=""   # Paste your GitHub token here (Settings → Developer Settings → Personal Access Tokens)
REPO_NAME="studiobills"
GITHUB_USERNAME=""   # Auto-detected below

echo ""
echo "🚀 StudioBills Deployment Script"
echo "================================="

# ── 1. Detect GitHub username ──────────────────────────────
echo "→ Getting GitHub username..."
GITHUB_USERNAME=$(curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])")

if [ -z "$GITHUB_USERNAME" ]; then
  echo "❌ Could not get GitHub username. Check your token."
  exit 1
fi
echo "   ✓ GitHub user: $GITHUB_USERNAME"

# ── 2. Create GitHub repo ──────────────────────────────────
echo "→ Creating GitHub repository '$REPO_NAME'..."
CREATE_RESULT=$(curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO_NAME\",\"description\":\"StudioBills - Income & Expense Tracker\",\"private\":false,\"auto_init\":false}")

REPO_URL=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('html_url',''))" 2>/dev/null)

if [ -z "$REPO_URL" ]; then
  # Repo might already exist
  REPO_URL="https://github.com/$GITHUB_USERNAME/$REPO_NAME"
  echo "   ℹ️  Repo may already exist at: $REPO_URL"
else
  echo "   ✓ Repo created: $REPO_URL"
fi

# ── 3. Push code to GitHub ─────────────────────────────────
echo "→ Pushing code to GitHub..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

git init
git config user.email "zalahardip70@gmail.com"
git config user.name "Hardip"
git checkout -b main 2>/dev/null || git checkout main 2>/dev/null
git add index.html vercel.json
git commit -m "StudioBills billing app" 2>/dev/null || echo "   (no new changes)"

REMOTE_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${REPO_NAME}.git"
git remote remove origin 2>/dev/null
git remote add origin "$REMOTE_URL"
git push -u origin main --force

echo "   ✓ Code pushed to GitHub"

# ── 4. Install & deploy Vercel ─────────────────────────────
echo "→ Deploying to Vercel..."

if ! command -v vercel &> /dev/null; then
  echo "   Installing Vercel CLI..."
  npm install -g vercel
fi

# Deploy (will prompt for login if not already logged in)
vercel --yes --name "$REPO_NAME" --prod

echo ""
echo "✅ Done! Your app is live on Vercel."
echo "   GitHub: https://github.com/$GITHUB_USERNAME/$REPO_NAME"
echo ""
echo "💡 Data note: Your billing data is stored in your browser (localStorage)."
echo "   It will persist every time you visit the live URL in the same browser."
echo ""
