#!/bin/bash
# Checks that the Astrala Wallet app on this Mac runs exactly the engine in this repository.
#   ./verify-engine.sh ["/Applications/Astrala Wallet.app"]
# Needs Node.js 22+. Builds the engine from source, pulls the same files out of the installed app, compares.
set -euo pipefail
APP="${1:-/Applications/Astrala Wallet.app}"
ASAR="$APP/Contents/Resources/app.asar"
[ -f "$ASAR" ] || { echo "Can't find $ASAR"; exit 1; }
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --silent
npm run -s build >/dev/null
TMP=$(mktemp -d)
npx --yes @electron/asar extract "$ASAR" "$TMP/app"
ok=1
# the app's engine also carries the operator settings (plain values, never code); set them aside first, see VERIFY.md
node verify-normalize.mjs "$TMP/app/out/main/index.js" out/main/index.js "$TMP/main-normalized.js" || exit 1
for f in out/main/index.js out/preload/index.cjs; do
  a=$(shasum -a 256 "$f" | cut -d' ' -f1)
  if [ "$f" = out/main/index.js ]; then b=$(shasum -a 256 "$TMP/main-normalized.js" | cut -d' ' -f1); else b=$(shasum -a 256 "$TMP/app/$f" | cut -d' ' -f1); fi
  if [ "$a" = "$b" ]; then echo "MATCH  $f  $a"; else echo "DIFFER $f"; echo "  source: $a"; echo "  app:    $b"; ok=0; fi
done
rm -rf "$TMP"
[ $ok = 1 ] && echo "The engine in your app is this code." || { echo "Mismatch. Make sure you checked out the tag matching your app version."; exit 1; }
