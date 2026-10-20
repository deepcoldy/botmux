#!/usr/bin/env bash
# Publish a directory into one path of the shared gh-pages branch as a single
# commit, so the branch never accumulates history.
#
# usage: publish-gh-pages.sh <source-dir> <target-path> <commit-message>
# env:   PAGES_REMOTE (git URL, required), PAGES_BRANCH (default gh-pages),
#        GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL
#
# Each Midscene run replaced a ~150 MB report directory with a new commit, and
# the repository grew to ~7 GB of history over ~1.6 GB of content. Here the
# new tree is committed without a parent and pushed with --force-with-lease
# against the commit it was built on: a concurrent publisher (docs vs report)
# makes the lease fail, and the publish starts over from the fresh branch
# instead of dropping the other side's change.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <source-dir> <target-path> <commit-message>" >&2
  exit 2
fi
src=$(cd "$1" && pwd)
target=$2
message=$3
remote=${PAGES_REMOTE:?PAGES_REMOTE is required}
branch=${PAGES_BRANCH:-gh-pages}
case "$target" in
  '' | /* | *..* | .*) echo "Unsafe target path: $target" >&2; exit 2 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for attempt in 1 2 3 4 5; do
  rm -rf "$work/pages"
  git clone -q --depth 1 --branch "$branch" "$remote" "$work/pages"
  cd "$work/pages"
  base=$(git rev-parse HEAD)
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -a "$src" "$target"
  git add -A
  if git diff --cached --quiet; then
    echo "Nothing changed under $target; not publishing."
    exit 0
  fi
  commit=$(git commit-tree "$(git write-tree)" -m "$message")
  if git push -q --force-with-lease="refs/heads/$branch:$base" origin "$commit:refs/heads/$branch"; then
    echo "Published $target as $commit (single commit on $branch)."
    exit 0
  fi
  echo "$branch moved while publishing (attempt $attempt); starting over."
  cd /
  sleep $((attempt * 10))
done
echo "::error::Could not publish $target: $branch kept moving." >&2
exit 1
