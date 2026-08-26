#!/bin/zsh

set -euo pipefail

KABUTORA_ROOT="${0:A:h:h}"
KABUTORA_WEB="$KABUTORA_ROOT/apps/web"
KABUTORA_APP="$KABUTORA_ROOT/株トラ.app"
KABUTORA_RUNTIME="/Users/sotay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

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

mkdir -p "$KABUTORA_STAGE/株トラ.app/Contents/MacOS"
mkdir -p "$KABUTORA_STAGE/株トラ.app/Contents/Resources/app"
cp "$KABUTORA_RUNTIME" "$KABUTORA_STAGE/株トラ.app/Contents/Resources/node"
cp -R "$KABUTORA_STANDALONE"/. "$KABUTORA_STAGE/株トラ.app/Contents/Resources/app/"

KABUTORA_RELATIVE_SERVER="${KABUTORA_SERVER#$KABUTORA_STANDALONE/}"
KABUTORA_SERVER_DIR="${KABUTORA_RELATIVE_SERVER:h}"
KABUTORA_PACKAGED_WEB="$KABUTORA_STAGE/株トラ.app/Contents/Resources/app/$KABUTORA_SERVER_DIR"
mkdir -p "$KABUTORA_PACKAGED_WEB/.next"
cp -R "$KABUTORA_WEB/public" "$KABUTORA_PACKAGED_WEB/public"
cp -R "$KABUTORA_WEB/.next/static" "$KABUTORA_PACKAGED_WEB/.next/static"

cp "$KABUTORA_ROOT/scripts/macos/Info.plist" "$KABUTORA_STAGE/株トラ.app/Contents/Info.plist"
cp "$KABUTORA_ROOT/scripts/macos/launcher" "$KABUTORA_STAGE/株トラ.app/Contents/MacOS/株トラ"
chmod +x "$KABUTORA_STAGE/株トラ.app/Contents/MacOS/株トラ"

KABUTORA_ICON_SOURCE="$KABUTORA_STAGE/株トラ.app/Contents/Resources/Kabutora.png"
"$KABUTORA_RUNTIME" "$KABUTORA_ROOT/scripts/render-icon.mjs" "$KABUTORA_WEB/public/icon.svg" "$KABUTORA_ICON_SOURCE"

if [[ -e "$KABUTORA_APP" ]]; then
  mv "$KABUTORA_APP" "$KABUTORA_STAGE/previous-株トラ.app"
fi
mv "$KABUTORA_STAGE/株トラ.app" "$KABUTORA_APP"
/usr/bin/xattr -cr "$KABUTORA_APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$KABUTORA_APP" >/dev/null

print "$KABUTORA_APP"
