#!/bin/sh
# Runs a command against a private Xvfb display, for the marketing captures
# (packages/desktop/README.md, "Marketing captures"), and stops that display,
# by the PID it saved, when the command ends.
#
#   sh e2e/marketing/xrun.sh <command> [args...]
#
# The screen is 3840x2160, so a 1920x1080 window at device scale factor 2
# fits on it whole: the stills and the videos are grabbed from it with x11grab.
#
# Xvfb comes from PATH, as on a CI-like Linux with the xvfb package, or from
# ORDEWELL_X_RUNTIME, the root of Debian packages unpacked without root
# (apt-get download xvfb x11-xkb-utils xserver-common libxfont2 libfontenc1,
# then dpkg -x each into one directory). Xvfb runs xkbcomp from the /usr/bin
# it was built for, so where the host has none this re-runs itself in a user
# and mount namespace (unshare -rm) that lays the runtime's xkbcomp over
# /usr/bin. The same namespace gives Xvfb a private /tmp/.X11-unix where the
# host's is not writable (WSLg mounts it read-only), and the command runs
# inside it, so it reaches the display. Nothing here needs root, and nothing
# outside the namespace changes.
#
# MARKETING_DISPLAY picks the display number; by default the first free one
# from 140 up, clear of :99 and the low numbers other tools take.
set -eu

fail() {
  printf 'xrun: %s\n' "$*" >&2
  exit 2
}

[ "$#" -gt 0 ] || fail 'usage: sh e2e/marketing/xrun.sh <command> [args...]'
[ "$(uname -s)" = Linux ] || fail "marketing captures run on Linux under Xvfb; this is $(uname -s). Run them on a Linux machine or in a Linux container."

runtime=${ORDEWELL_X_RUNTIME:-}
if command -v Xvfb >/dev/null 2>&1; then
  xvfb=$(command -v Xvfb)
elif [ -n "$runtime" ] && [ -x "$runtime/usr/bin/Xvfb" ]; then
  xvfb=$runtime/usr/bin/Xvfb
else
  fail 'no Xvfb: install the xvfb package, or set ORDEWELL_X_RUNTIME to a directory the xvfb and x11-xkb-utils packages were unpacked into (see the comment at the top of this script).'
fi

if [ -n "$runtime" ]; then
  libs=$runtime/usr/lib/x86_64-linux-gnu:$runtime/usr/lib/aarch64-linux-gnu:$runtime/usr/lib
  LD_LIBRARY_PATH=$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
  export LD_LIBRARY_PATH
fi

need_xkb=
[ -x /usr/bin/xkbcomp ] || need_xkb=1
# Xvfb makes /tmp/.X11-unix when it is missing, so only one it cannot write to needs replacing.
need_sockets=
if [ -e /tmp/.X11-unix ] && [ ! -w /tmp/.X11-unix ]; then need_sockets=1; fi
if [ -n "$need_xkb" ]; then
  [ -n "$runtime" ] && [ -x "$runtime/usr/bin/xkbcomp" ] || fail 'Xvfb needs /usr/bin/xkbcomp: install x11-xkb-utils, or unpack it into ORDEWELL_X_RUNTIME.'
fi
if [ -n "$need_xkb$need_sockets" ] && [ "${ORDEWELL_XRUN_INSIDE:-}" != 1 ]; then
  command -v unshare >/dev/null 2>&1 || fail 'no unshare, which is needed to lay xkbcomp over /usr/bin or give Xvfb a socket directory without root.'
  ORDEWELL_XRUN_INSIDE=1 exec unshare -rm sh "$0" "$@"
fi
if [ -n "$need_sockets" ]; then
  mount -t tmpfs -o mode=1777 tmpfs /tmp/.X11-unix || fail 'could not give Xvfb a private /tmp/.X11-unix (tmpfs mount in a user namespace refused).'
fi
if [ -n "$need_xkb" ]; then
  # A directory holding xkbcomp alone, laid over /usr/bin in this namespace only.
  over=$(mktemp -d "${TMPDIR:-/tmp}/ordewell-xkb.XXXXXX")
  cp "$runtime/usr/bin/xkbcomp" "$over/xkbcomp"
  mount -t overlay overlay -o "lowerdir=$over:/usr/bin" /usr/bin || fail 'could not lay xkbcomp over /usr/bin (overlay mount in a user namespace refused).'
fi

display=${MARKETING_DISPLAY:-}
if [ -z "$display" ]; then
  n=140
  while [ "$n" -lt 200 ]; do
    if [ ! -e "/tmp/.X$n-lock" ] && [ ! -e "/tmp/.X11-unix/X$n" ]; then display=$n; break; fi
    n=$((n + 1))
  done
  [ -n "$display" ] || fail 'no free display between :140 and :199; set MARKETING_DISPLAY.'
fi

log=$(mktemp "${TMPDIR:-/tmp}/ordewell-xvfb.XXXXXX")
"$xvfb" ":$display" -screen 0 3840x2160x24 -nolisten tcp -noreset >"$log" 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM

tries=0
until [ -e "/tmp/.X11-unix/X$display" ]; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then cat "$log" >&2; fail "Xvfb :$display exited before it listened (log above)."; fi
  if grep -q 'failed to create listener' "$log"; then cat "$log" >&2; fail "Xvfb :$display could not listen (log above)."; fi
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || fail "Xvfb :$display did not listen within ten seconds (log: $log)."
  sleep 0.1
done

DISPLAY=:$display
export DISPLAY
# The capture refuses any other display, so a run never grabs a developer's screen.
MARKETING_XVFB=:$display
export MARKETING_XVFB
status=0
"$@" || status=$?
exit "$status"
