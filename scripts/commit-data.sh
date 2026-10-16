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
# A lost race is NOT resolved by rebasing. These files are whole-file
# captures: every run rewrites each one end to end, so when two runs overlap
# git sees two complete rewrites of the same JSON and reports a conflict in
# every file. That is what happened on 16 October -- ten probes ran, every
# one of them succeeded, and the findings were thrown away by a rebase that
# could not possibly have succeeded. There is nothing to merge in a
# snapshot, and no hunk-level resolution that means anything.
#
# So the loser of a race does not replay its commit on top. It keeps the
# files it just generated, resets to whatever the remote now holds, puts its
# files back, and commits that. The newest capture wins, which is the only
# sensible answer for a snapshot, and there is no conflict to resolve.
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
  echo "push rejected or failed (attempt $attempt); taking the remote and reapplying this run's files"

  # Keep this run's output somewhere git will not touch.
  keep="$(mktemp -d)"
  for f in "$@"; do
    [ -e "$f" ] || continue
    mkdir -p "$keep/$(dirname "$f")"
    cp "$f" "$keep/$f"
  done

  # Take the remote exactly as it stands. A network failure lands here too,
  # in which case the fetch fails and the reset is a no-op against a stale
  # ref -- the push is simply retried.
  if git fetch origin "$branch"; then
    git reset --hard "origin/$branch"
  fi

  # Put this run's captures back on top of it.
  for f in "$@"; do
    [ -e "$keep/$f" ] || continue
    mkdir -p "$(dirname "$f")"
    cp "$keep/$f" "$f"
  done
  rm -rf "$keep"

  if [ -z "$(git status --porcelain -- "$@")" ]; then
    echo "remote already holds identical data; nothing to push"
    exit 0
  fi
  git add -- "$@"
  git commit -m "$msg"

  sleep $((2 ** attempt))
done

echo "still could not push to $branch after 5 attempts" >&2
exit 1
