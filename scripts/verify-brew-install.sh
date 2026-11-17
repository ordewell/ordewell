#!/usr/bin/env bash
# Install ordewell from ordewell/homebrew-tap the way a user does and prove it
# is the release just published (ADR-0063 H11, ADR-0065 C8): `brew install`,
# then `ordewell --version` against <version>, then the formula's own test,
# then on macOS the desktop cask when the tap carries this release's.
# The homebrew-verify jobs of release.yml and homebrew-publish.yml run it, on a
# runner of each platform the formula has an archive for. It reads the tap the
# way anyone can, so it holds no credential.
#
#   scripts/verify-brew-install.sh <version>
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: scripts/verify-brew-install.sh <version>" >&2; exit 2; }
version=$1
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "\"$version\" is not a version of the form x.y.z" >&2; exit 2; }

# Homebrew's own installer, pinned to a commit and the SHA-256 of its script,
# for a runner without brew: GitHub's Linux images carry it outside PATH, and
# an image may carry none.
installer_url=https://raw.githubusercontent.com/Homebrew/install/7986efac25016e41eed7e471666140c06f9d97cf/install.sh
installer_sha256=5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148

export HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

if ! command -v brew > /dev/null; then
  for candidate in /home/linuxbrew/.linuxbrew/bin/brew /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      break
    fi
  done
fi
if ! command -v brew > /dev/null; then
  installer=$(mktemp)
  curl -fsSL "$installer_url" -o "$installer"
  actual=$(sha256 "$installer")
  if [ "$actual" != "$installer_sha256" ]; then
    echo "Homebrew's install.sh hashed to $actual, not the pinned $installer_sha256" >&2
    exit 1
  fi
  NONINTERACTIVE=1 /bin/bash "$installer"
  rm -f "$installer"
  for candidate in /home/linuxbrew/.linuxbrew/bin/brew /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      break
    fi
  done
  command -v brew > /dev/null || { echo "Homebrew's installer ran, but no brew is on PATH" >&2; exit 1; }
fi
# A later step of the same job finds the brew this one found.
if [ -n "${GITHUB_PATH:-}" ]; then
  dirname "$(command -v brew)" >> "$GITHUB_PATH"
fi

brew --version
brew update
brew install ordewell/tap/ordewell

# The ordewell on PATH must be the one brew just linked, not one an image
# carried already.
prefix=$(brew --prefix)
found=$(command -v ordewell || true)
if [ "$found" != "$prefix/bin/ordewell" ]; then
  echo "ordewell on PATH is \"$found\", not Homebrew's $prefix/bin/ordewell" >&2
  exit 1
fi
reported=$(ordewell --version)
if [ "$reported" != "$version" ]; then
  echo "brew installed ordewell $reported, not the published $version" >&2
  exit 1
fi
echo "brew installed ordewell $reported"
brew test ordewell

# The cask, on macOS, installed the way a user does, after the formula and on
# its own trust (Homebrew 7 trusts what a fully qualified install names). Only
# a notarized build publishes it, so a tap whose cask is another release's, or
# none, has nothing of this one to prove. The app must be this release's and
# one Gatekeeper accepts. ORDEWELL_BREW_APPDIR stands in for /Applications in
# the tests alone.
if [ "$(uname -s)" = Darwin ]; then
  cask_file="$(brew --repository ordewell/tap)/Casks/ordewell-desktop.rb"
  if [ -f "$cask_file" ] && grep -qx "  version \"$version\"" "$cask_file"; then
    brew install --cask ordewell/tap/ordewell-desktop
    app="${ORDEWELL_BREW_APPDIR:-/Applications}/Ordewell.app"
    bundled=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")
    if [ "$bundled" != "$version" ]; then
      echo "brew installed Ordewell.app $bundled, not the published $version" >&2
      exit 1
    fi
    spctl --assess --type execute -vv "$app"
    echo "brew installed Ordewell.app $bundled"
    brew uninstall --cask ordewell/tap/ordewell-desktop
  else
    echo "the tap carries no ordewell-desktop $version cask, so there is no cask to install"
  fi
fi

# Every line audit reports is printed. It fails nothing: audit's findings on a
# third-party tap are about how the formula is written, which the next release
# can change, while the install and the test above are what a user gets.
if audit=$(brew audit --formula ordewell/tap/ordewell 2>&1); then
  echo "brew audit reported nothing"
else
  printf '%s\n' "$audit"
  echo "::warning::brew audit --formula ordewell/tap/ordewell reported the lines above (an install and its test passed regardless)."
fi
