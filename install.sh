#!/usr/bin/env bash
# pi-cvm install — register the package with pi and install the bash wrapper
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! pi list 2>/dev/null | grep -qF "$ROOT"; then
  pi install "$ROOT"
  echo "✓ registered $ROOT with pi (adds a settings entry; no copy — edits are live)"
else
  echo "✓ already registered with pi"
fi

mkdir -p "$HOME/bin"
cp "$ROOT/scripts/cvm" "$HOME/bin/cvm" && chmod +x "$HOME/bin/cvm"
echo "✓ installed ~/bin/cvm (one-shot / pool / exec / kill / cp / list)"

echo ""
echo "Done. Run /reload in pi (or restart) to load the cvm tool."
echo "Verify: pi list   ·   test: pi -p 'call cvm action=list'"
