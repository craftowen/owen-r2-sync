#!/bin/zsh
# 새 버전 릴리스: manifest.json 버전을 올린 뒤 실행.
#   ./scripts/release.sh            → build·package·tag·GitHub Release(자산 업로드)·Mac 플러그인 폴더 갱신
# 폰·Mac의 BRAT가 다음 시작 때 이 릴리스를 받아 자동 설치한다.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=craftowen/owen-r2-sync
VER=$(node -p "require('./manifest.json').version")
TAG="v$VER"
MAC_PLUGIN='/Users/owen/Library/Mobile Documents/iCloud~md~obsidian/Documents/owen-brain/.obsidian/plugins/owen-google-drive-sync'

npm run test:unit >/dev/null
npm run package >/dev/null
git add -A && git commit -q -m "release: $TAG" || true
git tag -f "$TAG" && git push -q origin main --tags

if ! gh api "repos/$REPO/releases/tags/$TAG" -q .id >/dev/null 2>&1; then
  gh api "repos/$REPO/releases" -X POST -f tag_name="$TAG" -f name="$TAG" -f body="${1:-Release $TAG}" >/dev/null
fi
ID=$(gh api "repos/$REPO/releases/tags/$TAG" -q .id)
TOKEN=$(gh auth token)
for f in main.js manifest.json styles.css; do
  AID=$(gh api "repos/$REPO/releases/$ID" -q ".assets[] | select(.name==\"$f\") | .id" || true)
  [[ -n "$AID" ]] && gh api -X DELETE "repos/$REPO/releases/assets/$AID" >/dev/null
  curl -sf -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"dist/owen-google-drive-sync/$f" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$f"
done
cp dist/owen-google-drive-sync/{main.js,manifest.json,styles.css} "$MAC_PLUGIN/"
echo "released $TAG → https://github.com/$REPO/releases/tag/$TAG (Mac 플러그인 폴더 갱신됨, Obsidian 재시작 또는 BRAT 업데이트 필요)"
