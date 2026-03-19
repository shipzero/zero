#!/usr/bin/env bash
set -euo pipefail

TAG="v$(date +%Y.%-m.%-d)"

git tag -d "$TAG" 2>/dev/null && git push origin ":refs/tags/$TAG" 2>/dev/null || true

git tag "$TAG"
git push origin "$TAG"

echo "released $TAG"
