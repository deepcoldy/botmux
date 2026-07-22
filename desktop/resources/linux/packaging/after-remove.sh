#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an Botmux install dir — never delete an unrelated
# /usr/bin/botmux-ide a user or other package may own.
set -e

link="/usr/bin/botmux-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Botmux/*|/opt/botmux-ide/*|/opt/botmux/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
