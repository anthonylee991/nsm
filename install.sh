#!/usr/bin/env sh
# nsm installer: source under the Bun runtime, no npm.
#   curl -fsSL https://raw.githubusercontent.com/anthonylee991/nsm/main/install.sh | sh
# Override the source for forks or a pinned version:
#   NSM_REPO=anthonylee991/nsm NSM_REF=v2.0.0 sh install.sh
set -eu

REPO="${NSM_REPO:-anthonylee991/nsm}"
REF="${NSM_REF:-main}"
HOME_DIR="${NSM_HOME:-$HOME/.nsm}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="$HOME_DIR/bin"
TARBALL="https://codeload.github.com/$REPO/tar.gz/$REF"

echo "[nsm] installing from $REPO@$REF into $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR"

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  echo "[nsm] Bun not found; installing Bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)"
echo "[nsm] bun: $BUN ($("$BUN" --version))"

# 2. Source
TMP="$(mktemp)"
curl -fsSL -o "$TMP" "$TARBALL"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$TMP" -C "$APP_DIR" --strip-components=1
rm -f "$TMP"

# 3. Dependencies (only the optional local-model library; NSM itself has none)
(cd "$APP_DIR" && "$BUN" install --silent)

# 4. Launcher on PATH
cat > "$BIN_DIR/nsm" <<EOF
#!/usr/bin/env sh
exec "$BUN" "$APP_DIR/bin/nsm.ts" "\$@"
EOF
chmod +x "$BIN_DIR/nsm"
if [ "$(uname -s | cut -c1-5)" = "MINGW" ] || [ "$(uname -s | cut -c1-4)" = "MSYS" ]; then
  printf '@echo off\r\n"%s" "%s" %%*\r\n' "$BUN" "$APP_DIR/bin/nsm.ts" > "$BIN_DIR/nsm.cmd"
fi

echo "[nsm] installed: $BIN_DIR/nsm"
"$BIN_DIR/nsm" --version >/dev/null && echo "[nsm] runs: $("$BIN_DIR/nsm" --version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "[nsm] add to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "[nsm] next:  nsm setup claude-code      (or cursor | codex | generic)"
echo "[nsm] optional, better recall:  nsm models install   (about 250 MB, once)"
