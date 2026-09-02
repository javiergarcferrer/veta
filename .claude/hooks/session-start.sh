#!/bin/bash
# SessionStart hook — the harness's first move, before the model reads a line.
#
# CLAUDE.md names the two things every remote session gets wrong in its first
# minute: it starts with no node_modules (so every signal dies
# ERR_MODULE_NOT_FOUND and reads as a red), and it starts without knowing
# whether another session moved `main` (so it builds on stale ground). This
# script does both mechanically. Web sessions only — a desk already has its
# own node_modules and its own habits. Ported from RosetSoft's harness.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# 1. Toolchain. `npm install` (not `ci`) so a cached container keeps its
#    node_modules across sessions; the lockfile still pins every version.
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then
  echo "[harness] installing node_modules…"
  if ! npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -3; then
    echo "[harness] npm install FAILED — report the blocked host (\$HTTPS_PROXY/__agentproxy/status names it); never route around it."
  fi
else
  echo "[harness] node_modules present"
fi

# 2. Reconcile. Sessions share this repo; `main` is what deploys.
git fetch origin main -q 2>/dev/null || echo "[harness] could not fetch origin/main"
echo "[harness] branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
echo "[harness] vs origin/main: ahead ${ahead}, behind ${behind}"
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
echo "[harness] working tree: ${dirty} changed file(s)"

# 3. The migration chain's high-water mark — a new file must out-date it.
latest=$(ls supabase/migrations/*.sql 2>/dev/null | sort | tail -1 | xargs -n1 basename 2>/dev/null)
echo "[harness] latest migration: ${latest:-none}"

# 4. Where this deploy stands against upstream. VETA's engines come from
#    RosetSoft and are ported in `upstream sync:` commits; the newest one is
#    the high-water mark of what has been ported.
sync=$(git log --format='%s' -n 200 2>/dev/null | grep -m1 '^upstream sync:' || true)
echo "[harness] last upstream sync: ${sync:-none recorded}"

# 5. Where the rules are.
echo "[harness] read CLAUDE.md first; docs/harness.md explains every file that shapes a session"
exit 0
