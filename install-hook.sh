#!/bin/bash
# install-hook.sh <repo-dir> <src-rel-path[,src-rel-path...]> [invariants-file]
# Installs an architectural-invariant PRE-COMMIT gate into <repo>/.git/hooks/pre-commit.
# The hook blocks a commit that makes architecture WORSE THAN HEAD (ratchet vs the last commit),
# so rot can't land. Existing debt in HEAD is accepted (ratchet baseline); only NEW debt blocks.
# <src-rel-path> may be a COMMA-SEPARATED list of dirs (e.g. "engine,tools") — each is gated
# independently against its OWN HEAD baseline, so a repo with separate source trees is fully covered
# without scanning unrelated dirs (e.g. linked worktrees / vendored copies under the repo root).
# Bypass (discouraged): git commit --no-verify.  [invariants-file] defaults to the gate's invariants.json.
set -euo pipefail
REPO="${1:?usage: install-hook.sh <repo-dir> <src-rel-path[,...]> [invariants-file]}"
SRC="${2:?usage: install-hook.sh <repo-dir> <src-rel-path[,...]> [invariants-file]}"
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
ARCH_SRCS="$SRC"                          # comma-separated list of src-rel dirs
repo="\$(git rev-parse --show-toplevel)"
tmp="\$(mktemp -d)"; trap 'rm -rf "\$tmp"' EXIT
have_head=0; git rev-parse --verify -q HEAD >/dev/null && have_head=1
[ "\$have_head" = 1 ] && git archive HEAD | tar -x -C "\$tmp" 2>/dev/null || true   # HEAD tree once

fail=0
IFS=',' read -ra _DIRS <<< "\$ARCH_SRCS"
for d in "\${_DIRS[@]}"; do
  [ -n "\$d" ] || continue
  bl="\$tmp/baseline-\$(printf '%s' "\$d" | tr '/.' '__').json"
  echo '{}' > "\$bl"                       # no HEAD (or dir absent in HEAD) -> only absolute checks
  if [ "\$have_head" = 1 ] && [ -d "\$tmp/\$d" ]; then
    node "\$ARCH_GATE" "\$tmp/\$d" $INV_FLAG --baseline --baseline-out "\$bl" >/dev/null 2>&1 || true
  fi
  if [ -d "\$repo/\$d" ]; then
    node "\$ARCH_GATE" "\$repo/\$d" $INV_FLAG --baseline-in "\$bl" || fail=1
  fi
done

if [ "\$fail" != 0 ]; then
  echo ""
  echo ">> commit BLOCKED: architectural-invariant regression vs HEAD. Fix the violation(s) above,"
  echo "   or record a deliberate baseline change. Bypass (discouraged): git commit --no-verify"
  exit 1
fi
EOF
chmod +x "$HOOK"
echo "installed pre-commit gate -> $HOOK   (watching '$SRC', invariants='${INV:-default}')"
