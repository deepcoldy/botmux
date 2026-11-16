#!/usr/bin/env bash
# CI only (.github/workflows/ci.yml, jobs `test` and `bun-test`): let the
# sandbox / namespace integration tests really run bwrap on a GitHub-hosted
# Ubuntu runner.
#
# Best-effort by design: this script never fails the job. Every test that needs
# bwrap has a runtime gate and skips loudly when the host cannot do it. The job
# of this script is to make sure that does NOT happen on CI, and to raise a
# ::warning:: annotation when it does anyway.
#
# Host settings, each one measured on the runner image that needed it:
#  1. Ubuntu >= 23.10 sets kernel.apparmor_restrict_unprivileged_userns=1. An
#     unconfined bwrap then fails at once with "setting up uid map: Permission
#     denied".
#  2. ubuntu-24.04 images do not ship bubblewrap. Run apt-get update first: the
#     image's apt index lags the mirror. A superseded 0.9.0-1ubuntu0.1 made
#     every mirror return 404 (master CI was red from it on 2026-09-19).
#  3. ubuntu-26.04 images (`ubuntu-latest` since 2026-11) ship bubblewrap 0.11
#     and load AppArmor's bwrap-userns-restrict profile. /usr/bin/bwrap may still
#     create namespaces, but every process it runs is confined as
#     `bwrap//&unpriv_bwrap`, which denies all capabilities. A bwrap started
#     inside a bwrap therefore cannot set up its namespaces. The kernel logs
#     apparmor="DENIED" operation="capable" profile="unpriv_bwrap"
#     capname="sys_admin", and bwrap prints "No permissions to create a new
#     namespace, likely because the kernel does not allow non-privileged user
#     namespaces". The sysctl in (1) does not lift a loaded profile's explicit
#     deny. Unloading the profile gives the same unconfined bwrap as on 24.04,
#     which is what the tests were written against. This only changes the
#     throwaway runner; product code is untouched.
set -u

# A healthy runner finishes the privileged part in about 10s. A hung sudo/apt
# prints nothing and would otherwise burn the whole job timeout, and `|| true`
# does not help while it hangs, so the whole block is capped at 90s.
timeout -k 15s 90s bash -c '
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
  command -v bwrap >/dev/null || (sudo apt-get update && sudo apt-get install -y bubblewrap) || true
  if [ -e /etc/apparmor.d/bwrap-userns-restrict ]; then
    sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict \
      && echo "unloaded AppArmor profile bwrap-userns-restrict (bwrap, unpriv_bwrap)" || true
  fi
' || echo "bwrap setup timed out — continuing without a confirmed sandbox"

# Probe what the tests actually run, with the namespace set from
# test/linux-isolation.test.ts. The old one-level probe (`bwrap --bind / /
# --unshare-user`) printed "OK" on ubuntu-26.04 while every nested case failed.
ns=(--ro-bind / / --unshare-user --unshare-pid --unshare-net --proc /proc --dev /dev --)

if err=$(bwrap "${ns[@]}" /bin/true 2>&1); then
  echo "bwrap userns OK — sandbox integration tests will run for real"
else
  echo "::warning title=bwrap unavailable::sandbox integration tests will skip (see their runtime gates): ${err:-no output}"
fi

if err=$(bwrap "${ns[@]}" bwrap "${ns[@]}" /bin/true 2>&1); then
  echo "nested bwrap OK — nested-namespace cases will run for real"
else
  echo "::warning title=nested bwrap unavailable::nested-namespace cases in test/linux-isolation.test.ts will skip: ${err:-no output}"
fi

exit 0
