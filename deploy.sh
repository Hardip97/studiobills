#!/bin/bash
set -euo pipefail

# ============================================================
# StudioBills – GitHub + Vercel Deployment Script
# Uses standard git credentials / SSH (never embeds tokens in .git/config)
# ============================================================

REPO_NAME="studiobills"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "🚀 StudioBills Deployment Script"
echo "================================="

if [ ! -d ".git" ]; then
  echo "❌ Not a git repository. Clone or initialize your repo first."
  exit 1
fi

echo "→ Staging all tracked and new project files..."
git add -A

if git diff --cached --quiet; then
  echo "   (no new changes to commit)"
else
  git commit -m "${1:-Update StudioBills}"
fi

echo "→ Pushing to origin main..."
git push origin main

echo "→ Deploying to Vercel..."
if ! command -v vercel &> /dev/null; then
  echo "   Installing Vercel CLI..."
  npm install -g vercel
fi

vercel --yes --name "$REPO_NAME" --prod
echo "✅ Done! Deployment triggered on Vercel."
