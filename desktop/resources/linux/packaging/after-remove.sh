#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an OrcaBotmux install dir — never delete an unrelated
# /usr/bin/orca_botmux-ide a user or other package may own.
set -e

link="/usr/bin/orca_botmux-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/OrcaBotmux/*|/opt/orca_botmux-ide/*|/opt/orca_botmux/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
