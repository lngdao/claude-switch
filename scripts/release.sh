#!/usr/bin/env bash
# Release script — creates a date-based version tag and pushes it.
# The CI workflow (.github/workflows/publish.yml) picks up the tag and
# publishes the package to npm with provenance.
#
# Version format: YYYY.MDD.N — semver-compatible, no leading zero on month.
#   Apr  9 → 2026.409.1
#   Dec 31 → 2026.1231.1
#   Apr  9, second release of the day → 2026.409.2
#
# Usage:
#   ./scripts/release.sh              # Auto-increment build number for today
#   ./scripts/release.sh --dry        # Show what would happen, no changes
#   ./scripts/release.sh 2026.409.5   # Explicit version (escape hatch)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0
EXPLICIT_VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run) DRY=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) EXPLICIT_VERSION="$arg" ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────

# Working tree must be clean (otherwise the release commit picks up stray changes)
if [[ -n "$(git status --porcelain)" ]]; then
  echo -e "${RED}Working tree is dirty. Commit or stash first.${NC}" >&2
  git status --short >&2
  exit 1
fi

# Must be on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo -e "${YELLOW}Warning: not on main (current: $BRANCH).${NC}"
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo ""
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
fi

# ── Current version ───────────────────────────────────────
CURRENT=$(node -p "require('./package.json').version")
echo -e "Current version: ${YELLOW}${CURRENT}${NC}"

# ── Calculate next version ────────────────────────────────
YEAR=$(date +%Y)
MONTH=$(date +"%-m")
DAY=$(date +"%d")
TODAY_PREFIX="${YEAR}.${MONTH}${DAY}"

if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEXT="$EXPLICIT_VERSION"
else
  # Find highest existing patch for today's prefix (across local + remote tags)
  PATCH=0
  # Make sure we have remote tags so we don't collide
  git fetch --tags --quiet 2>/dev/null || true
  for tag in $(git tag -l "v${TODAY_PREFIX}.*" 2>/dev/null); do
    P="${tag##*.}"
    if [[ "$P" =~ ^[0-9]+$ ]] && (( P > PATCH )); then
      PATCH=$P
    fi
  done
  PATCH=$((PATCH + 1))
  NEXT="${TODAY_PREFIX}.${PATCH}"
fi

TAG="v${NEXT}"
echo -e "Next version:    ${GREEN}${NEXT}${NC}  (tag: ${TAG})"
echo ""

# ── Commits since last tag ────────────────────────────────
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
echo -e "${CYAN}Commits to include:${NC}"
if [[ -n "$LATEST_TAG" ]]; then
  git log --oneline "${LATEST_TAG}..HEAD" 2>/dev/null || git log --oneline -10
else
  git log --oneline -10
fi
echo ""

# ── Sanity build ──────────────────────────────────────────
echo -e "${CYAN}Running typecheck + tests + build…${NC}"
if [[ $DRY -eq 1 ]]; then
  echo -e "${DIM}  (skipped in --dry)${NC}"
else
  npm run typecheck >/dev/null
  echo -e "  ${GREEN}✓${NC} typecheck"
  npm test --silent >/dev/null
  echo -e "  ${GREEN}✓${NC} tests"
  npm run build >/dev/null 2>&1
  echo -e "  ${GREEN}✓${NC} build"
fi
echo ""

if [[ $DRY -eq 1 ]]; then
  echo -e "${DIM}Dry run — no changes made.${NC}"
  exit 0
fi

# ── Confirm ───────────────────────────────────────────────
read -p "Release ${TAG}? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

# ── Sync version in package.json ──────────────────────────
echo -e "${CYAN}Syncing version ${NEXT} into package.json…${NC}"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEXT}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "  package.json → ${NEXT}"

# Also keep package-lock.json in sync if present
if [[ -f package-lock.json ]]; then
  node -e "
  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  lock.version = '${NEXT}';
  if (lock.packages && lock.packages['']) lock.packages[''].version = '${NEXT}';
  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  "
  echo "  package-lock.json → ${NEXT}"
fi

# ── Commit, tag, push ─────────────────────────────────────
git add package.json
[[ -f package-lock.json ]] && git add package-lock.json
git commit -m "release: ${NEXT}"
git tag -a "${TAG}" -m "Release ${TAG}"
git push origin HEAD "${TAG}"

echo ""
echo -e "${GREEN}✓ Released ${TAG}${NC}"

REMOTE_URL=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')
echo -e "  Actions: ${YELLOW}${REMOTE_URL}/actions${NC}"
echo -e "  Release: ${YELLOW}${REMOTE_URL}/releases/tag/${TAG}${NC}"
echo -e "  npm:     ${YELLOW}https://www.npmjs.com/package/$(node -p "require('./package.json').name")${NC}"
