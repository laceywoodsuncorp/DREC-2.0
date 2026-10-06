#!/usr/bin/env bash
# Commits and pushes data a workflow has just produced, surviving a push race.
#
# Every scheduled workflow in this repo writes to data/ on the same branch,
# and the branch is also pushed to by hand. When two pushes overlap the loser
# is rejected as a non-fast-forward -- and because the push is the last step,
# a rejection silently discards work that already succeeded. That is what
# happened to run 32 of Scrape outages: it fetched every operator, wrote the
# snapshot, uploaded its artifacts, committed, and then threw the lot away on
# "! [rejected] (fetch first)".
#
# Retrying the push alone does not help, and the retry loop that was in
# diagnose.yml is a good example of why: a non-fast-forward is still a
# non-fast-forward five seconds later. The remote work has to be pulled in
# first, which is what this does.
#
# Rebase rather than merge, because these commits are one-line data snapshots
# and a merge commit per collision would bury the real history. --autostash
# covers any file a workflow wrote but did not list.
#
# Usage:  scripts/commit-data.sh "commit message" path [path...]
# Env:    BRANCH   branch to push to (default: current, or $GITHUB_REF_NAME
#                  when the checkout is detached)
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 \"commit message\" path [path...]" >&2
  exit 2
fi
msg="$1"; shift

branch="${BRANCH:-}"
if [ -z "$branch" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  # A detached checkout reports "HEAD", which is not a push target.
  [ "$branch" = "HEAD" ] && branch="${GITHUB_REF_NAME:-}"
fi
if [ -z "$branch" ]; then
  echo "No branch to push to: set BRANCH or GITHUB_REF_NAME." >&2
  exit 2
fi

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# --porcelain, not `git diff`: a diff only compares tracked files, so the
# first run of a new probe wrote its findings and the check reported
# "no change" and discarded them. That has already happened here once.
if [ -z "$(git status --porcelain -- "$@")" ]; then
  echo "No change in: $*"
  exit 0
fi

git add -- "$@"
git commit -m "$msg"

for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:$branch"; then
    echo "pushed to $branch on attempt $attempt"
    exit 0
  fi
  echo "push rejected or failed (attempt $attempt); rebasing onto origin/$branch"
  # A network failure and a lost race both land here. Fetch, replay our
  # snapshot on top, try again.
  git fetch origin "$branch" || true
  if ! git rebase --autostash "origin/$branch"; then
    git rebase --abort || true
    echo "could not rebase onto origin/$branch" >&2
    exit 1
  fi
  sleep $((2 ** attempt))
done

echo "still could not push to $branch after 5 attempts" >&2
exit 1
