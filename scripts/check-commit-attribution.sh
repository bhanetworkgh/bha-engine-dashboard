#!/bin/sh
# Lists every commit on the given range (default: all of main) that is authored or committed by Claude or
# carries a Claude co-author line. Exit 1 if any. Run before a push:  sh scripts/check-commit-attribution.sh
range="${1:-HEAD}"
bad=0
for h in $(git rev-list "$range"); do
  if git log -1 --format='%ae%n%ce%n%B' "$h" | grep -qiE 'noreply@anthropic|^Co-Authored-By: Claude|^Claude-Session:|Generated with \[?Claude Code'; then
    git log -1 --format='%h %ad %an <%ae>  %s' --date=short "$h"
    bad=$((bad+1))
  fi
done
[ "$bad" -eq 0 ] && echo "clean: no commit carries Claude" && exit 0
echo "$bad commit(s) carry Claude" >&2
exit 1
