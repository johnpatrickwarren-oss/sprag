#!/bin/bash
# install-hook.sh <repo-dir> <src-rel-path> [invariants-file]
# Installs an architectural-invariant PRE-COMMIT gate into <repo>/.git/hooks/pre-commit.
# The hook blocks a commit that makes architecture WORSE THAN HEAD (ratchet vs the last commit),
# so rot can't land. Existing debt in HEAD is accepted (ratchet baseline); only NEW debt blocks.
# Bypass (discouraged): git commit --no-verify.  [invariants-file] defaults to the gate's invariants.json.
set -euo pipefail
REPO="${1:?usage: install-hook.sh <repo-dir> <src-rel-path> [invariants-file]}"
SRC="${2:?usage: install-hook.sh <repo-dir> <src-rel-path> [invariants-file]}"
GATE="$(cd "$(dirname "$0")" && pwd)/arch-gate.mjs"
INV="${3:-}"
[ -n "$INV" ] && INV="$(cd "$(dirname "$INV")" && pwd)/$(basename "$INV")"   # absolutize
INV_FLAG=""; [ -n "$INV" ] && INV_FLAG="--invariants \"$INV\""
HOOK="$REPO/.git/hooks/pre-commit"
mkdir -p "$(dirname "$HOOK")"
if [ -e "$HOOK" ] && ! grep -q 'architectural-invariant pre-commit gate' "$HOOK"; then
  cp "$HOOK" "$HOOK.pre-archgate.bak"; echo "backed up existing hook -> $HOOK.pre-archgate.bak"
fi

# Unquoted heredoc: $GATE/$SRC/$INV are baked in now; \$runtime vars stay literal for the hook.
cat > "$HOOK" <<EOF
#!/bin/bash
# architectural-invariant pre-commit gate (anchor prototypes/architectural-gate).
set -uo pipefail
ARCH_GATE="$GATE"
ARCH_SRC="$SRC"
repo="\$(git rev-parse --show-toplevel)"
tmp="\$(mktemp -d)"; trap 'rm -rf "\$tmp"' EXIT
echo '{}' > "\$tmp/baseline.json"          # no HEAD yet -> only absolute checks apply
if git rev-parse --verify -q HEAD >/dev/null; then
  git archive HEAD | tar -x -C "\$tmp" 2>/dev/null || true
  if [ -d "\$tmp/\$ARCH_SRC" ]; then
    node "\$ARCH_GATE" "\$tmp/\$ARCH_SRC" $INV_FLAG --baseline --baseline-out "\$tmp/baseline.json" >/dev/null 2>&1 || true
  fi
fi
if ! node "\$ARCH_GATE" "\$repo/\$ARCH_SRC" $INV_FLAG --baseline-in "\$tmp/baseline.json"; then
  echo ""
  echo ">> commit BLOCKED: architectural-invariant regression vs HEAD. Fix the violation(s) above,"
  echo "   or record a deliberate baseline change. Bypass (discouraged): git commit --no-verify"
  exit 1
fi
EOF
chmod +x "$HOOK"
echo "installed pre-commit gate -> $HOOK   (watching '$SRC', invariants='${INV:-default}')"
