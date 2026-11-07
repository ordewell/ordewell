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
# `npm install -g ordewell`; so does musl Linux (Alpine), which the glibc-linked
# binary cannot run on.
#
# Options:
#   --version X.Y.Z   install that release instead of the latest (or ORDEWELL_VERSION)
#   --uninstall       remove the binary and the runtime files it unpacked into
#                     ~/.ordewell/runtime (kept while another ordewell is on
#                     PATH, which uses them too); sessions and other data stay
#   --dry-run         say what would be downloaded and installed, and do nothing
#   -h, --help        this text
#
# --desktop (left out of --help and of this list until a release carries the
# desktop app, ADR-0065 C10) also runs the desktop app installer (desktop.sh),
# passing --version, --uninstall and --dry-run on. When the release's
# SHA256SUMS lists no desktop installer, the CLI is installed, the script says
# the desktop app is not released yet and exits 1.
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

# Until main() runs and takes this trap over, ending means the file stopped short
# of its last line: a cut-off download that left only whole functions. That must
# not look like a success that did nothing.
trap 'printf "ordewell: this installer ended before its last line (a cut-off download?), so nothing was installed.\n" >&2; exit 1' EXIT

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

# Colour for what the user must act on, only on a terminal that shows it.
# Through `curl ... | sh` stdin is the pipe but stdout is still the terminal.
# NO_COLOR wins; FORCE_COLOR or CLICOLOR_FORCE, other than 0, forces it on.
red='' bold='' off=''
forced() { [ -n "$1" ] && [ "$1" != 0 ]; }
if [ -z "${NO_COLOR:-}" ] && { forced "${FORCE_COLOR:-}" || forced "${CLICOLOR_FORCE:-}" || { [ -t 1 ] && [ "${TERM:-}" != dumb ]; }; }; then
  esc=$(printf '\033')
  red="${esc}[1;31m" bold="${esc}[1m" off="${esc}[0m"
fi

usage() {
  cat <<'EOF'
Installs the Ordewell command-line app for the current user (macOS and Linux).
It is one self-contained binary; Node.js is not needed.

Usage: install.sh [--version X.Y.Z] [--uninstall] [--dry-run]

  --version X.Y.Z  install that release instead of the latest (or ORDEWELL_VERSION)
  --uninstall      remove the binary and ~/.ordewell/runtime (the runtime stays
                   while another ordewell is on PATH, which uses it too);
                   sessions and other data in ~/.ordewell stay
  --dry-run        say what would be downloaded and installed, and do nothing
  -h, --help       this text

Environment:
  ORDEWELL_VERSION       the same as --version
  ORDEWELL_CLI_FROM      a directory or an https:// base URL holding
                         ordewell-<os>-<arch>.tar.gz (and the versioned name)
                         and SHA256SUMS, used instead of the GitHub Release
  ORDEWELL_INSTALL_DIR   the folder the binary goes in (default ~/.local/bin)

On Windows and on musl Linux (Alpine), install with: npm install -g ordewell
EOF
}

tmp=
staged=
# Run by the EXIT trap that main sets, which shellcheck 0.11 does not follow into
# a function, so it reports this one as never invoked.
# shellcheck disable=SC2329
cleanup() {
  status=$?
  [ -z "$staged" ] || rm -f "$staged"
  [ -z "$tmp" ] || rm -rf "$tmp"
  exit "$status"
}

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
      # The subshell is the point: main's own ORDEWELL_INSTALL_DIR is left alone.
      # shellcheck disable=SC2030
      ORDEWELL_INSTALL_DIR=$ORDEWELL_DESKTOP_INSTALL_DIR
      export ORDEWELL_INSTALL_DIR
    fi
    exec sh "$tmp/desktop.sh" "$@"
  ) || die "the desktop app installer failed (the command-line app above is unaffected)"
}

# The Linux binaries are linked against glibc, so on musl (Alpine and many
# Docker images) one would install and then fail with a bare "not found". ldd
# names its libc on the first line it prints (musl's goes to stderr and exits
# 1, so both are read); only without an answer from ldd are the musl loader
# files looked for, since a glibc system can have the musl package installed.
# ORDEWELL_TEST_LIBC (musl or glibc) is for the tests and is not documented.
is_musl() {
  case ${ORDEWELL_TEST_LIBC:-} in
    musl) return 0 ;;
    glibc) return 1 ;;
  esac
  if command -v ldd >/dev/null 2>&1; then
    case $(ldd --version 2>&1 || true) in
      *[Mm][Uu][Ss][Ll]*) return 0 ;;
      *[Gg][Ll][Ii][Bb][Cc]*|*'GNU libc'*) return 1 ;;
    esac
  fi
  for loader in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
    [ -e "$loader" ] && return 0
  done
  return 1
}

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

# An ordewell this installer did not put there, and how to remove it, from its
# path and, for a symlink, where that points: npm's or Homebrew's command, or
# nothing when neither installed it.
removal() {
  removal_link=$1
  if command -v readlink >/dev/null 2>&1; then
    removal_link=$(readlink "$1" 2>/dev/null || printf '%s' "$1")
  fi
  case "$1 $removal_link" in
    *node_modules*|*/npm/*) printf '%s' "${bold}npm uninstall -g ordewell${off}      # it was installed with npm" ;;
    *Cellar*|*homebrew*|*linuxbrew*) printf '%s' "${bold}brew uninstall ordewell${off}        # it was installed with Homebrew" ;;
  esac
}

# Every ordewell on PATH except $bin_path and $resolved, colon-joined in PATH's
# order in $others. A shell that ran one before this install remembers (hashes)
# its path and keeps running it, so a copy after this one matters too. None is
# run to ask its version: an old one's startup migrates config files, and sh has
# no portable timeout.
scan_path() {
  others=
  case $- in *f*) had_noglob=1 ;; *) had_noglob= ;; esac
  had_ifs=${IFS+1}
  saved_ifs=${IFS-}
  set -f
  IFS=:
  # The ':' appended keeps a trailing empty entry, which field splitting drops.
  for dir in ${PATH:+$PATH:}; do
    case $dir in
      ''|.) dir=$PWD ;;
      ./*) dir=$PWD/${dir#./} ;;
      /*) ;;
      *) dir=$PWD/$dir ;;
    esac
    file=${dir%/}/$BIN_NAME
    { [ -f "$file" ] && [ -x "$file" ]; } || continue
    # A symlink at $bin_path can point at another copy, which stays when it goes.
    # shellcheck disable=SC3013
    if [ "$file" = "$bin_path" ] || { [ ! -L "$bin_path" ] && [ "$file" -ef "$bin_path" ]; }; then continue; fi
    # shellcheck disable=SC3013
    if [ -n "$resolved" ] && [ "$file" -ef "$resolved" ]; then continue; fi
    seen=
    for other in $others; do
      # shellcheck disable=SC3013
      if [ "$file" -ef "$other" ]; then seen=1; break; fi
    done
    [ -n "$seen" ] || others=${others:+$others:}$file
  done
  restore_split
}

# Puts back the field splitting and globbing scan_path changed.
restore_split() {
  if [ -n "$had_ifs" ]; then IFS=$saved_ifs; else unset IFS; fi
  [ -n "$had_noglob" ] || set +f
}


# Says each of $others and how to remove it, in PATH's order.
say_others() {
  set -f
  IFS=:
  for other in $others; do
    say "Another ordewell is $1on your PATH$2: $other"
    how=$(removal "$other")
    say "  To remove it: ${how:-delete $other}"
  done
  restore_split
}

# What the user must act on, last on screen so it does not scroll past: the
# PATH line to add, then any other ordewell. A shell that ran an old copy keeps
# its remembered path, and once that copy is removed fails with "No such file
# or directory", so hash -r stays the step for this terminal either way.
closing() {
  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add it for your shell, then open a new terminal:"
      case $(basename "${SHELL:-sh}") in
        fish) say "  ${bold}fish_add_path \"$install_dir\"${off}" ;;
        zsh) say "  ${bold}echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc${off}" ;;
        bash) say "  ${bold}echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.bashrc${off}" ;;
        *) say "  ${bold}export PATH=\"$install_dir:\$PATH\"${off}    # add this line to your shell's startup file" ;;
      esac
      ;;
  esac
  if [ -n "$resolved" ]; then
    say ""
    say "${red}Typing ordewell, even in a new terminal, runs another copy, not the one just installed.${off}"
    say "It comes first on your PATH: $resolved"
    [ -n "$relative" ] && say "(found through a PATH entry relative to the folder you are in, $PWD)"
    say "To use $bin_path instead:"
    how=$(removal "$resolved")
    say "  ${how:-delete $resolved}"
    say "  or put $install_dir before ${resolved%/*} on your PATH."
    say_others 'also ' ''
    say "Either way, this terminal keeps running the copy it ran before until you run:"
  elif [ -n "$others" ]; then
    say ""
    say "${red}This terminal may still run another ordewell, not the one just installed.${off}"
    say_others '' ', after this one'
    say "New terminals run the new one."
    say "This terminal keeps running the copy it ran before, even once that copy is removed, until you run:"
  else
    return 0
  fi
  say "  ${bold}hash -r${off}      # or open a new terminal"
}

# Everything that does anything is in main(), which the last line calls. `curl … |
# sh` runs each command as it arrives, so a download cut off midway would run
# whatever came, and a script that exits early (`--help`) leaves sh no longer
# reading, so curl reports a write error (23). sh runs a function only once it has
# parsed it to the closing brace, and main is called by the final line, so a
# cut-off script is a syntax error that runs nothing (or, cut between functions,
# ends at the trap at the top), and sh has read the whole file before main
# starts. What is outside main only defines things; the variables the functions
# read are set by main (functions share one scope).
main() {
  trap cleanup EXIT
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

  # shellcheck disable=SC2031
  install_dir=${ORDEWELL_INSTALL_DIR:-$HOME/.local/bin}
  bin_path=$install_dir/$BIN_NAME
  runtime_dir=$HOME/.ordewell/runtime

  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  # ---- uninstall ----------------------------------------------------------------

  # ~/.ordewell/runtime is shared: every copy of ordewell unpacks its files into
  # it and reads them from it, so it goes only when no other copy is left on PATH.
  # A binary unpacks a missing folder again at its next start (seaRuntimeDir), so
  # this is not about data, but a copy running now would lose files under it.
  if [ "$uninstall" = 1 ]; then
    resolved=
    if [ "$dry_run" = 1 ]; then
      scan_path
      say "Would remove $bin_path"
      if [ -n "$others" ]; then
        say "Would keep $runtime_dir: another ordewell is on your PATH (${others%%:*})"
      else
        say "Would remove $runtime_dir"
      fi
    else
      found=0
      if [ -e "$bin_path" ] || [ -L "$bin_path" ]; then
        rm -f "$bin_path"
        say "Removed $bin_path"
        found=1
      fi
      scan_path
      if [ -d "$runtime_dir" ]; then
        found=1
        if [ -n "$others" ]; then
          say "Kept $runtime_dir: another ordewell is on your PATH (${others%%:*}) and uses it"
        else
          rm -rf "$runtime_dir"
          say "Removed $runtime_dir"
        fi
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

  if [ "$os" = linux ] && is_musl; then
    die "the standalone binary needs a glibc-based Linux, and this system uses musl (Alpine, for example). Install with npm instead: npm install -g ordewell (Node.js 20.3 or newer)"
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

  # ---- fetch and verify ---------------------------------------------------------
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


  # The first ordewell on PATH is what a new shell runs; an older install (npm's,
  # Homebrew's, another folder's) earlier than this one would still be it, so say
  # which one and how to switch.
  resolved=$(command -v "$BIN_NAME" 2>/dev/null || true)
  # A relative PATH entry is printed relative to this folder (`old/ordewell`), and
  # dash prints an empty entry's match as the bare name, so make it absolute.
  relative=
  case $resolved in
    /*|'') ;;
    */*) relative=1; resolved=$PWD/${resolved#./} ;;
    *) if [ -f "./$resolved" ]; then relative=1; resolved=$PWD/$resolved; else resolved=; fi ;;
  esac
  # -ef is not in POSIX but every sh this runs under has it; it sees the same
  # file through a symlinked folder or a doubled slash.
  # shellcheck disable=SC3013
  if [ -n "$resolved" ] && { [ "$resolved" = "$bin_path" ] || [ "$resolved" -ef "$bin_path" ]; }; then
    resolved=
  fi


  scan_path

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

  exit_status=0
  if [ "$want_desktop" = 1 ]; then
    # A release made with the desktop app left out (release.yml's
    # ORDEWELL_RELEASE_DESKTOP off, ADR-0065 C10) lists only the CLI's files. The
    # CLI stays installed; the exit status tells a calling script the app is not.
    if awk '{ name = $2; sub(/^\*/, "", name); if (name ~ /^Ordewell-/) { found = 1; exit } } END { exit !found }' "$tmp/SHA256SUMS"; then
      run_desktop
    else
      note ""
      note "The Ordewell desktop app isn't released yet, so --desktop installed nothing more. The CLI is installed."
      exit_status=1
    fi
  fi
  closing
  exit "$exit_status"
}

main "$@"
