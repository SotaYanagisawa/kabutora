#!/bin/zsh

set -euo pipefail

KABUTORA_ROOT="${0:A:h:h}"
KABUTORA_WEB="$KABUTORA_ROOT/apps/web"
KABUTORA_APP="$KABUTORA_ROOT/株トラ iPhone Preview.app"
KABUTORA_RUNTIME="/Users/sotay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
KABUTORA_SWIFTC="$(xcrun --find swiftc)"
KABUTORA_SDK="$(xcrun --sdk macosx --show-sdk-path)"
KABUTORA_MODULE_CACHE="/tmp/kabutora-swift-module-cache"

if [[ ! -x "$KABUTORA_RUNTIME" ]]; then
  KABUTORA_RUNTIME="$(command -v node || true)"
fi
if [[ -z "$KABUTORA_RUNTIME" || ! -x "$KABUTORA_RUNTIME" ]]; then
  print -u2 "Node.js runtime was not found."
  exit 1
fi

"$KABUTORA_RUNTIME" "$KABUTORA_WEB/node_modules/next/dist/bin/next" build "$KABUTORA_WEB"

KABUTORA_STANDALONE="$KABUTORA_WEB/.next/standalone"
KABUTORA_SERVER="$(find "$KABUTORA_STANDALONE" -path '*/apps/web/server.js' -print -quit)"
if [[ -z "$KABUTORA_SERVER" ]]; then
  KABUTORA_SERVER="$(find "$KABUTORA_STANDALONE" -name server.js -print -quit)"
fi
if [[ -z "$KABUTORA_SERVER" ]]; then
  print -u2 "Next.js standalone server was not generated."
  exit 1
fi

KABUTORA_STAGE="$(mktemp -d)"
trap 'rm -rf "$KABUTORA_STAGE"' EXIT
KABUTORA_STAGE_APP="$KABUTORA_STAGE/株トラ iPhone Preview.app"
mkdir -p "$KABUTORA_STAGE_APP/Contents/MacOS"
mkdir -p "$KABUTORA_STAGE_APP/Contents/Resources/app"

CLANG_MODULE_CACHE_PATH="$KABUTORA_MODULE_CACHE" "$KABUTORA_SWIFTC" -sdk "$KABUTORA_SDK" -module-cache-path "$KABUTORA_MODULE_CACHE" -O -framework Cocoa -framework WebKit \
  "$KABUTORA_ROOT/scripts/macos/iphone-preview.swift" \
  -o "$KABUTORA_STAGE_APP/Contents/MacOS/株トラ iPhone Preview"

cp "$KABUTORA_RUNTIME" "$KABUTORA_STAGE_APP/Contents/Resources/node"
cp -R "$KABUTORA_STANDALONE"/. "$KABUTORA_STAGE_APP/Contents/Resources/app/"

KABUTORA_RELATIVE_SERVER="${KABUTORA_SERVER#$KABUTORA_STANDALONE/}"
KABUTORA_SERVER_DIR="${KABUTORA_RELATIVE_SERVER:h}"
KABUTORA_PACKAGED_WEB="$KABUTORA_STAGE_APP/Contents/Resources/app/$KABUTORA_SERVER_DIR"
mkdir -p "$KABUTORA_PACKAGED_WEB/.next"
cp -R "$KABUTORA_WEB/public" "$KABUTORA_PACKAGED_WEB/public"
cp -R "$KABUTORA_WEB/.next/static" "$KABUTORA_PACKAGED_WEB/.next/static"

cp "$KABUTORA_ROOT/scripts/macos/iPhonePreview-Info.plist" "$KABUTORA_STAGE_APP/Contents/Info.plist"
"$KABUTORA_RUNTIME" "$KABUTORA_ROOT/scripts/render-icon.mjs" "$KABUTORA_ROOT/scripts/macos/app-icon.png" "$KABUTORA_STAGE_APP/Contents/Resources/Kabutora.png"

if [[ -e "$KABUTORA_APP" ]]; then
  mv "$KABUTORA_APP" "$KABUTORA_STAGE/previous-preview.app"
fi
mv "$KABUTORA_STAGE_APP" "$KABUTORA_APP"
/usr/bin/xattr -cr "$KABUTORA_APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$KABUTORA_APP" >/dev/null

print "$KABUTORA_APP"
