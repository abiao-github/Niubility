#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/safari}"
PROJECT_DIR="$OUTPUT/project"
DERIVED_DATA="$OUTPUT/DerivedData"
APP_NAME="NiuBiliTy Safari"
SIGNING_IDENTITY="${CODE_SIGN_IDENTITY:--}"

mkdir -p "$OUTPUT"
xcrun safari-web-extension-converter \
  --no-open \
  --no-prompt \
  --copy-resources \
  --force \
  --macos-only \
  --swift \
  --app-name "$APP_NAME" \
  --bundle-identifier com.niubility.downloader.NiuBiliTy-Safari \
  --project-location "$PROJECT_DIR" \
  "$ROOT/extension/safari"

xcodebuild \
  -project "$PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" \
  -configuration Release \
  -arch arm64 \
  -derivedDataPath "$DERIVED_DATA" \
  "CODE_SIGN_IDENTITY=$SIGNING_IDENTITY" \
  CODE_SIGNING_ALLOWED=YES \
  MACOSX_DEPLOYMENT_TARGET=14.0

APP_PATH="$DERIVED_DATA/Build/Products/Release/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  printf 'Safari extension app was not produced at %s\n' "$APP_PATH" >&2
  exit 1
fi

ditto "$APP_PATH" "$OUTPUT/$APP_NAME.app"
ditto -c -k --sequesterRsrc --keepParent "$OUTPUT/$APP_NAME.app" "$OUTPUT/NiuBiliTy-Safari-macos-arm64.zip"
