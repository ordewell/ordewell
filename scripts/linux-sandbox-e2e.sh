#!/usr/bin/env bash
# The Linux backend is bubblewrap, and its real-sandbox suites skip where it
# cannot start. CI installs it and lifts Ubuntu's user-namespace restriction
# the way docs/troubleshooting.md tells a user to: the narrow AppArmor profile
# where the package ships one, the system-wide sysctl otherwise (or if the
# profile does not take). ORDEWELL_REQUIRE_SANDBOX turns a probe that still
# fails into a failing test, so a green run here means the sandbox really
# started.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if ! command -v bwrap >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y bubblewrap
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y bubblewrap
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm bubblewrap
  else
    echo 'bubblewrap (bwrap) is not installed, and this host has no package manager this step knows.' >&2
    exit 1
  fi
fi

# The native-shell tests in sealedRuns.e2e.test.ts start the shells a user has,
# and skip the ones this host lacks. The runner image has no zsh, so install it
# for them to run; fish stays optional.
if ! command -v zsh >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y zsh
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y zsh
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm zsh
  else
    echo 'zsh is not installed, and this host has no package manager this step knows; the native-shell tests skip.' >&2
  fi
fi

restricted() {
  [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]
}

if restricted; then
  profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
  if [ ! -f "$profile" ] && command -v apt-get >/dev/null 2>&1; then
    # Best effort: the wide fix below is the fallback when the package is unavailable.
    if ! { sudo apt-get update && sudo apt-get install -y apparmor-profiles apparmor-utils; }; then
      echo 'Could not install apparmor-profiles; falling back to the system-wide restriction lift.' >&2
    fi
  fi
  loaded=0
  # Ubuntu ships the profile in apparmor-profiles but does not install it.
  if [ -f "$profile" ] \
     && sudo install -m 0644 "$profile" /etc/apparmor.d/bwrap-userns-restrict \
     && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict; then
    loaded=1
  fi
  if [ "$loaded" = 0 ]; then
    echo 'No usable bwrap AppArmor profile on this host; lifting the restriction system-wide instead.' >&2
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  fi
fi

# The check docs/troubleshooting.md gives a user, so a broken fix fails here
# with bubblewrap's own message instead of inside the suite. The profile can
# load and still not let bwrap start, in which case the wide fix is the only
# lever this step has.
if ! bwrap --ro-bind / / true; then
  if restricted; then
    echo 'The bwrap AppArmor profile did not let bubblewrap start; lifting the restriction system-wide.' >&2
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    bwrap --ro-bind / / true
  else
    exit 1
  fi
fi

ORDEWELL_REQUIRE_SANDBOX=1 npm run test:sandbox -w packages/core
