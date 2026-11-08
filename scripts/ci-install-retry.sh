#!/bin/sh
# Usage: sh scripts/ci-install-retry.sh <install command...>
#
# Runs a CI dependency install and retries it with backoff when it fails. These
# installs fail transiently on upstream 5xx (registry tarballs, node-gyp
# headers, electron's binary download) before any test has run, and the same
# command succeeds minutes later. The attempts are bounded so a real failure
# (lockfile drift, a broken lifecycle script) still fails the job, with the
# last attempt's exit status.
#
# node_modules is kept between attempts: bun reruns a trusted dependency's
# lifecycle script that failed on the previous run, so a retry finishes the
# interrupted install instead of starting over.
#
# POSIX sh: this also runs inside node:22-alpine (BusyBox) and manylinux.
set -u

[ "$#" -gt 0 ] || {
  echo "usage: $0 <install command...>" >&2
  exit 2
}

max_attempts=3
attempt=1
while :; do
  "$@" && exit 0
  status=$?
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "ci-install-retry: giving up after $attempt attempts (exit $status): $*" >&2
    exit "$status"
  fi
  delay=$((attempt * 15))
  echo "ci-install-retry: attempt $attempt/$max_attempts failed (exit $status), retrying in ${delay}s: $*" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
