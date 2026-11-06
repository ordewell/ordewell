#!/bin/sh
# Installs the Ordewell command-line app for the current user, on macOS and
# Linux. It is one self-contained binary: Node.js is not needed (ADR-0065 C7).
#
#   curl -fsSL https://ordewell.ai/install.sh | sh
#   curl -fsSL https://ordewell.ai/install.sh | sh -s -- --version 0.12.3
#
# It downloads the archive for this OS and CPU from the GitHub Release over
# https, checks its SHA-256 against the release's SHA256SUMS and stops on any
# mismatch, then installs the `ordewell` binary into ~/.local/bin without sudo.
# Running it again upgrades. It never edits a shell profile: when the install
# folder is not on PATH it says which line to add. On Windows, install with
# `npm install -g ordewell`.
#
# Options:
#   --version X.Y.Z   install that release instead of the latest (or ORDEWELL_VERSION)
#   --uninstall       remove the binary and the runtime files it unpacked into
#                     ~/.ordewell/runtime; sessions and other data stay
#   --dry-run         say what would be downloaded and installed, and do nothing
#   --desktop         also run the desktop app installer (desktop.sh), passing
#                     --version, --uninstall and --dry-run on; when the
#                     release's SHA256SUMS lists no desktop installer, the CLI
#                     is installed, the script says the release has no desktop
#                     app and exits 1 (ADR-0065 C10)
#   -h, --help        this text
#
# Environment:
#   ORDEWELL_VERSION       the same as --version
#   ORDEWELL_CLI_FROM      a directory or an https:// base URL holding
#                          ordewell-<os>-<arch>.tar.gz, the versioned
#                          ordewell-<version>-<os>-<arch>.tar.gz and SHA256SUMS,
#                          used instead of the GitHub Release
#   ORDEWELL_INSTALL_DIR   the folder the binary goes in (default ~/.local/bin)
#   ORDEWELL_DESKTOP_SCRIPT_FROM
#                          a file or an https:// URL to take desktop.sh from
#                          with --desktop, instead of the copy on GitHub
#   ORDEWELL_DESKTOP_INSTALL_DIR
#                          with --desktop, handed to desktop.sh as its own
#                          ORDEWELL_INSTALL_DIR (the folder Ordewell.app goes
#                          in on macOS, the prefix replacing ~/.local on
#                          Linux); this script's ORDEWELL_INSTALL_DIR is never
#                          passed on, since it names the CLI's folder

set -eu

REPO=ordewell/ordewell
BIN_NAME=ordewell
DESKTOP_SCRIPT_URL=https://raw.githubusercontent.com/$REPO/main/scripts/install/desktop.sh
# The runners Ordewell drives, as `command:name`. These are the commands in
# packages/core/src/plugins/builtin/*.manifest.ts (runner.command), with the
# manifest's displayName.
AGENTS='claude:Claude Code
codex:Codex
opencode:OpenCode
copilot:GitHub Copilot CLI
qwen:Qwen Code
cline:Cline
gemini:Gemini CLI
cursor-agent:Cursor'

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die() { printf 'ordewell: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Installs the Ordewell command-line app for the current user (macOS and Linux).
It is one self-contained binary; Node.js is not needed.

Usage: install.sh [--version X.Y.Z] [--uninstall] [--dry-run] [--desktop]

  --version X.Y.Z  install that release instead of the latest (or ORDEWELL_VERSION)
  --uninstall      remove the binary and ~/.ordewell/runtime; sessions and other
                   data in ~/.ordewell stay
  --dry-run        say what would be downloaded and installed, and do nothing
  --desktop        also run the desktop app installer, passing --version,
                   --uninstall and --dry-run on, when the release carries it
  -h, --help       this text

Environment:
  ORDEWELL_VERSION       the same as --version
  ORDEWELL_CLI_FROM      a directory or an https:// base URL holding
                         ordewell-<os>-<arch>.tar.gz (and the versioned name)
                         and SHA256SUMS, used instead of the GitHub Release
  ORDEWELL_INSTALL_DIR   the folder the binary goes in (default ~/.local/bin)
  ORDEWELL_DESKTOP_SCRIPT_FROM
                         a file or an https:// URL to take desktop.sh from
                         with --desktop
  ORDEWELL_DESKTOP_INSTALL_DIR
                         with --desktop, where the desktop app goes: passed to
                         desktop.sh as its ORDEWELL_INSTALL_DIR (the CLI's
                         ORDEWELL_INSTALL_DIR is not passed on)

On Windows, install with: npm install -g ordewell
EOF
}

version=${ORDEWELL_VERSION:-}
uninstall=0
dry_run=0
want_desktop=0
while [ $# -gt 0 ]; do
  case $1 in
    --version)
      [ $# -ge 2 ] || die "--version needs a value, for example --version 0.12.3"
      version=$2
      shift 2
      ;;
    --version=*) version=${1#--version=}; shift ;;
    --uninstall) uninstall=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --desktop) want_desktop=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# A version names a release tag, so it is checked before it reaches a URL.
version=${version#v}
if [ -n "$version" ]; then
  case $version in
    *[!0-9A-Za-z.+-]*|.*|-*|+*) die "not a version: $version (expected X.Y.Z)" ;;
  esac
  case $version in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "not a version: $version (expected X.Y.Z)" ;;
  esac
fi

[ -n "${HOME:-}" ] || die "HOME is not set"

install_dir=${ORDEWELL_INSTALL_DIR:-$HOME/.local/bin}
bin_path=$install_dir/$BIN_NAME
runtime_dir=$HOME/.ordewell/runtime

tmp=
staged=
cleanup() {
  status=$?
  [ -z "$staged" ] || rm -f "$staged"
  [ -z "$tmp" ] || rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

make_tmp() {
  [ -n "$tmp" ] || tmp=$(mktemp -d "${TMPDIR:-/tmp}/ordewell-cli.XXXXXX") || die "could not make a temporary directory"
}

# ---- the desktop installer, for --desktop -------------------------------------

fetch() {
  case $1 in https://*) ;; *) die "refusing to download over anything but https: $1" ;; esac
  if command -v curl >/dev/null 2>&1; then
    if [ -t 2 ]; then
      curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --progress-bar -o "$2" "$1"
    else
      curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "needs curl or wget to download, and found neither"
  fi || die "could not download $1"
}

run_desktop() {
  make_tmp
  from=${ORDEWELL_DESKTOP_SCRIPT_FROM:-$DESKTOP_SCRIPT_URL}
  case $from in
    https://*) fetch "$from" "$tmp/desktop.sh" ;;
    *)
      [ -f "$from" ] || die "ORDEWELL_DESKTOP_SCRIPT_FROM is not a file or an https URL: $from"
      cp "$from" "$tmp/desktop.sh"
      ;;
  esac
  set --
  [ -z "$version" ] || set -- "$@" --version "$version"
  [ "$uninstall" = 0 ] || set -- "$@" --uninstall
  [ "$dry_run" = 0 ] || set -- "$@" --dry-run
  say ""
  say "Running the desktop app installer"
  # ORDEWELL_INSTALL_DIR means the CLI's folder here and the app's folder or
  # prefix in desktop.sh, so the CLI's value is never passed on: the desktop
  # installer gets ORDEWELL_DESKTOP_INSTALL_DIR, or its own defaults.
  (
    unset ORDEWELL_INSTALL_DIR
    if [ -n "${ORDEWELL_DESKTOP_INSTALL_DIR:-}" ]; then
      ORDEWELL_INSTALL_DIR=$ORDEWELL_DESKTOP_INSTALL_DIR
      export ORDEWELL_INSTALL_DIR
    fi
    exec sh "$tmp/desktop.sh" "$@"
  ) || die "the desktop app installer failed (the command-line app above is unaffected)"
}

# ---- uninstall ----------------------------------------------------------------

if [ "$uninstall" = 1 ]; then
  if [ "$dry_run" = 1 ]; then
    say "Would remove $bin_path"
    say "Would remove $runtime_dir"
  else
    found=0
    if [ -e "$bin_path" ] || [ -L "$bin_path" ]; then
      rm -f "$bin_path"
      say "Removed $bin_path"
      found=1
    fi
    if [ -d "$runtime_dir" ]; then
      rm -rf "$runtime_dir"
      say "Removed $runtime_dir"
      found=1
    fi
    [ "$found" = 1 ] || say "No Ordewell install found, so nothing was removed."
    say "Your sessions and settings in ~/.ordewell were left in place."
  fi
  [ "$want_desktop" = 0 ] || run_desktop
  exit 0
fi

# ---- which file, from where ---------------------------------------------------

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "this script is for macOS and Linux; on Windows install with: npm install -g ordewell" ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "no Ordewell build for the $(uname -m) architecture" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple-silicon Mac, and
# the native build is the one to install.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

if [ -n "$version" ]; then
  asset=$BIN_NAME-$version-$os-$arch.tar.gz
else
  asset=$BIN_NAME-$os-$arch.tar.gz
fi

from_dir=
asset_url=
sums_url=
if [ -n "${ORDEWELL_CLI_FROM:-}" ]; then
  case $ORDEWELL_CLI_FROM in
    https://*)
      base=${ORDEWELL_CLI_FROM%/}
      asset_url=$base/$asset
      sums_url=$base/SHA256SUMS
      source_desc="$base"
      ;;
    *)
      [ -d "$ORDEWELL_CLI_FROM" ] || die "ORDEWELL_CLI_FROM is not a directory or an https URL: $ORDEWELL_CLI_FROM"
      from_dir=$ORDEWELL_CLI_FROM
      source_desc="the directory $from_dir"
      ;;
  esac
else
  if [ -n "$version" ]; then
    base=https://github.com/$REPO/releases/download/v$version
    source_desc="release v$version"
  else
    base=https://github.com/$REPO/releases/latest/download
    source_desc="the latest release"
  fi
  asset_url=$base/$asset
  sums_url=$base/SHA256SUMS
fi

if [ "$dry_run" = 1 ]; then
  say "Platform:  $os $arch"
  say "File:      $asset"
  say "From:      $source_desc"
  if [ -n "$asset_url" ]; then
    say "Download:  $asset_url"
    say "Checksums: $sums_url"
  fi
  say "Install:   $bin_path"
  [ "$want_desktop" = 0 ] || run_desktop
  exit 0
fi

# ---- fetch and verify ---------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    die "needs sha256sum, shasum or openssl to check the download, and found none"
  fi
}

make_tmp
if [ -n "$from_dir" ]; then
  [ -f "$from_dir/SHA256SUMS" ] || die "no SHA256SUMS in $from_dir"
  [ -f "$from_dir/$asset" ] || die "no $asset in $from_dir"
  cp "$from_dir/SHA256SUMS" "$tmp/SHA256SUMS"
  # A copy, so what is checked is what is installed.
  cp "$from_dir/$asset" "$tmp/$asset"
else
  say "Downloading $asset from $source_desc"
  fetch "$sums_url" "$tmp/SHA256SUMS"
  fetch "$asset_url" "$tmp/$asset"
fi

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS" | tr 'A-F' 'a-f')
case $expected in
  *[!0-9a-f]*|'') die "SHA256SUMS has no checksum for $asset" ;;
esac
[ "${#expected}" = 64 ] || die "SHA256SUMS has no checksum for $asset"
actual=$(sha256_of "$tmp/$asset" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  note "ordewell: the checksum of $asset does not match SHA256SUMS."
  note "  expected $expected"
  note "  got      $actual"
  note "Nothing was installed. If a release was published while this ran, run it again."
  exit 1
fi
say "Checksum verified (sha256 $actual)"

# ---- install ------------------------------------------------------------------

mkdir "$tmp/extract"
tar -xzf "$tmp/$asset" -C "$tmp/extract" || die "could not unpack $asset"
[ -f "$tmp/extract/$BIN_NAME" ] || die "$asset holds no $BIN_NAME at its top level"

mkdir -p "$install_dir" || die "could not create $install_dir"
[ -w "$install_dir" ] || die "$install_dir is not writable; use ORDEWELL_INSTALL_DIR=\$HOME/.local/bin"
# Written beside its destination and renamed over it, so an upgrade works
# while the old binary is running.
staged=$install_dir/.$BIN_NAME.new.$$
cp "$tmp/extract/$BIN_NAME" "$staged" || die "could not write to $install_dir"
chmod 755 "$staged"
mv -f "$staged" "$bin_path" || die "could not put $BIN_NAME in $install_dir"
staged=

if ! version_out=$("$bin_path" --version 2>&1); then
  die "installed $bin_path, but it did not run: $bin_path --version failed"
fi
installed_version=$(printf '%s\n' "$version_out" | head -n 1)
say "Installed ordewell $installed_version to $bin_path"

case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    say ""
    say "$install_dir is not on your PATH. Add it for your shell, then open a new terminal:"
    case $(basename "${SHELL:-sh}") in
      fish) say "  fish_add_path \"$install_dir\"" ;;
      zsh) say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc" ;;
      bash) say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.bashrc" ;;
      *) say "  export PATH=\"$install_dir:\$PATH\"    # add this line to your shell's startup file" ;;
    esac
    ;;
esac

# ---- what Ordewell works with: reported, never installed -----------------------

say ""
if command -v git >/dev/null 2>&1; then
  git_version=$(git --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p' | head -n 1)
  git_major=${git_version%%.*}
  git_minor=${git_version#*.}
  if [ -z "$git_version" ]; then
    say "git: found, but its version could not be read. git 2.38 or newer is recommended."
  elif [ "$git_major" -lt 2 ] || { [ "$git_major" = 2 ] && [ "$git_minor" -lt 38 ]; }; then
    say "git: $git_version is older than the recommended 2.38. Ordewell still works; isolated worktrees, delegated tasks and Merge all need 2.38 or newer."
  else
    say "git: $git_version found."
  fi
else
  say "git: not found. It is optional: without git, or outside a git repository, tasks run directly in the folder without worktrees."
  say "     git 2.38 or newer is recommended: it gives isolated worktrees, delegated tasks and Merge all."
fi

found_agents=
all_agents=
while IFS=: read -r cmd label; do
  all_agents="${all_agents:+$all_agents, }$label ($cmd)"
  if command -v "$cmd" >/dev/null 2>&1; then
    found_agents="${found_agents:+$found_agents, }$label ($cmd)"
  fi
done <<EOF
$AGENTS
EOF
if [ -n "$found_agents" ]; then
  say "Coding agents found: $found_agents."
  say "A coding agent, installed and signed in, is required; sign in to the one you want to use."
else
  say "No coding agent was found on PATH. Ordewell needs one, installed and signed in: $all_agents."
fi

[ "$want_desktop" = 1 ] || exit 0
# A release made with the desktop app left out (release.yml's
# ORDEWELL_RELEASE_DESKTOP off, ADR-0065 C10) lists only the CLI's files. The
# CLI stays installed; the exit status tells a calling script the app is not.
if ! awk '{ name = $2; sub(/^\*/, "", name); if (name ~ /^Ordewell-/) { found = 1; exit } } END { exit !found }' "$tmp/SHA256SUMS"; then
  note ""
  note "ordewell: this release does not include the desktop app yet, so only the command-line app was installed."
  exit 1
fi
run_desktop
