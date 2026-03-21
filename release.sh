#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--preview" ]; then
  TAG="preview-$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
else
  TAG="v$(date +%Y.%-m.%-d)"
  git tag -d "$TAG" 2>/dev/null && git push origin ":refs/tags/$TAG" 2>/dev/null || true
fi

git tag "$TAG"
git push origin "$TAG"

echo "released $TAG"
