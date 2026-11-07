#!/bin/sh
# Installs the Ordewell desktop app for the current user, on macOS and Linux
# (ADR-0063 H10):
#
#   curl -fsSL https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.sh | sh
#   curl -fsSL .../desktop.sh | sh -s -- --version 0.12.3
#
# It downloads the installer from the GitHub Release over https, checks its
# SHA-256 against the release's SHA256SUMS and stops on any mismatch, then
# installs it without sudo: Ordewell.app into /Applications (or ~/Applications
# when /Applications is not writable) on macOS, the AppImage into
# ~/.local/bin on Linux. Running it again upgrades. It never removes a
# quarantine attribute or changes any OS protection.
#
# Options:
#   --version X.Y.Z   install that release instead of the latest (or ORDEWELL_VERSION)
#   --deb             Linux: install the .deb with apt or dpkg, using sudo
#   --uninstall       remove what this script installed (with --deb: the package)
#   --dry-run         say what would be downloaded and installed, and do nothing
#   -h, --help        this text
#
# Environment:
#   ORDEWELL_VERSION       the same as --version
#   ORDEWELL_DESKTOP_FROM  a directory holding Ordewell-<os>-<arch>.<ext> and
#                          SHA256SUMS (see scripts/desktop-release-assets.mjs),
#                          used instead of downloading
#   ORDEWELL_INSTALL_DIR   macOS: the directory Ordewell.app goes in.
#                          Linux: the prefix that replaces ~/.local

set -eu

# Until main() runs and takes this trap over, ending means the file stopped short
# of its last line: a cut-off download that left only whole functions. That must
# not look like a success that did nothing.
trap 'printf "ordewell-desktop: this installer ended before its last line (a cut-off download?), so nothing was installed.\n" >&2; exit 1' EXIT

REPO=ordewell/ordewell
APP=Ordewell.app
BUNDLE_ID=ai.ordewell.desktop
BIN_NAME=ordewell-desktop

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die() { printf 'ordewell-desktop: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Installs the Ordewell desktop app for the current user (macOS and Linux).

Usage: desktop.sh [--version X.Y.Z] [--deb] [--uninstall] [--dry-run]

  --version X.Y.Z  install that release instead of the latest (or ORDEWELL_VERSION)
  --deb            Linux: install the .deb with apt or dpkg, using sudo
  --uninstall      remove what this script installed (with --deb: the package)
  --dry-run        say what would be downloaded and installed, and do nothing
  -h, --help       this text

Environment:
  ORDEWELL_VERSION       the same as --version
  ORDEWELL_DESKTOP_FROM  a directory holding Ordewell-<os>-<arch>.<ext> and
                         SHA256SUMS, used instead of downloading
  ORDEWELL_INSTALL_DIR   macOS: the directory Ordewell.app goes in.
                         Linux: the prefix that replaces ~/.local
EOF
}

mnt=
staged=
tmp=

# ---- where things go ---------------------------------------------------------

mac_target_dir() {
  if [ -n "${ORDEWELL_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$ORDEWELL_INSTALL_DIR"
  elif [ -d /Applications ] && [ -w /Applications ]; then
    printf '%s\n' /Applications
  else
    printf '%s\n' "$HOME/Applications"
  fi
}

# ---- uninstall ---------------------------------------------------------------

# Only a bundle that is Ordewell's is ever removed or replaced: a folder that
# happens to be called Ordewell.app is somebody else's.
is_ours() {
  [ -f "$1/Contents/Info.plist" ] && grep -q "$BUNDLE_ID" "$1/Contents/Info.plist"
}

run_privileged() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "installing a package needs root, and sudo is not available"
  fi
}

uninstall_mac() {
  found=0
  if [ -n "${ORDEWELL_INSTALL_DIR:-}" ]; then set -- "$ORDEWELL_INSTALL_DIR"; else set -- /Applications "$HOME/Applications"; fi
  for dir in "$@"; do
    [ -d "$dir/$APP" ] || continue
    if is_ours "$dir/$APP"; then
      rm -rf "${dir:?}/${APP:?}" || die "could not remove $dir/$APP (is it owned by another user? try sudo)"
      say "Removed $dir/$APP"
      found=1
    else
      note "Left $dir/$APP alone: it is not Ordewell's ($BUNDLE_ID)."
    fi
  done
  [ "$found" = 1 ] || say "No Ordewell.app found, so nothing was removed."
  say "Your sessions and settings in ~/Library/Application Support/Ordewell and ~/.ordewell were left in place."
}

uninstall_linux() {
  if [ "$want_deb" = 1 ]; then
    command -v dpkg >/dev/null 2>&1 || die "--deb needs dpkg"
    owner=$(dpkg -S "/usr/bin/$BIN_NAME" 2>/dev/null | head -n 1 | cut -d: -f1 || true)
    if [ -n "$owner" ]; then
      if command -v apt-get >/dev/null 2>&1; then run_privileged apt-get remove -y "$owner"; else run_privileged dpkg -r "$owner"; fi
      say "Removed the package $owner"
    else
      say "No installed package provides /usr/bin/$BIN_NAME."
    fi
    return 0
  fi
  found=0
  for path in "$linux_bin" "$linux_entry" "$linux_icon"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -f "$path"
      say "Removed $path"
      found=1
    fi
  done
  [ "$found" = 1 ] || say "No Ordewell AppImage install found under $linux_prefix, so nothing was removed."
  refresh_desktop_database
  say "Your sessions and settings in ~/.config/Ordewell and ~/.ordewell were left in place."
}

refresh_desktop_database() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$linux_prefix/share/applications" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  status=$?
  if [ -n "$mnt" ] && [ -d "$mnt" ]; then
    hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || hdiutil detach "$mnt" -force -quiet >/dev/null 2>&1 || true
  fi
  [ -z "$staged" ] || rm -rf "$staged"
  rm -rf "$tmp"
  exit "$status"
}

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

install_mac() {
  command -v hdiutil >/dev/null 2>&1 || die "hdiutil not found"
  dest=$(mac_target_dir)
  mkdir -p "$dest" || die "could not create $dest"
  [ -w "$dest" ] || die "$dest is not writable; use ORDEWELL_INSTALL_DIR=\$HOME/Applications"
  if [ -d "$dest/$APP" ]; then
    is_ours "$dest/$APP" || die "$dest/$APP exists and is not Ordewell's ($BUNDLE_ID); not replacing it"
    if pgrep -f "$dest/$APP/Contents/MacOS/" >/dev/null 2>&1; then
      die "Ordewell is running from $dest/$APP; quit it and run this again"
    fi
  fi

  mnt=$tmp/mnt
  mkdir "$mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$tmp/$asset" >/dev/null \
    || die "could not mount $asset"
  [ -d "$mnt/$APP" ] || die "$asset holds no $APP"
  staged=$dest/.$APP.new.$$
  rm -rf "$staged"
  ditto "$mnt/$APP" "$staged" || die "could not copy $APP to $dest"
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || hdiutil detach "$mnt" -force -quiet >/dev/null 2>&1 || true
  mnt=

  previous=
  if [ -d "$dest/$APP" ]; then
    previous=$dest/.$APP.old.$$
    mv "$dest/$APP" "$previous"
  fi
  if ! mv "$staged" "$dest/$APP"; then
    [ -z "$previous" ] || mv "$previous" "$dest/$APP"
    die "could not put $APP in $dest"
  fi
  staged=
  [ -z "$previous" ] || rm -rf "$previous"

  say "Installed $label to $dest/$APP"
  say "Start it from Launchpad or Spotlight, or:  open \"$dest/$APP\""
  say ""
  say "This script did not add or remove any quarantine attribute. A file curl"
  say "downloads carries none, so macOS does not run its first-launch Gatekeeper"
  say "prompt as it would for a browser download. See docs/desktop/README.md."
}

install_linux_appimage() {
  mkdir -p "$linux_prefix/bin" "$linux_prefix/share/applications" "$linux_prefix/share/icons/hicolor/512x512/apps" \
    || die "could not create directories under $linux_prefix"
  # Written beside its destination and renamed over it, so an upgrade works
  # while the old AppImage is running.
  cp "$tmp/$asset" "$linux_bin.new.$$"
  chmod 755 "$linux_bin.new.$$"
  mv -f "$linux_bin.new.$$" "$linux_bin"

  # The icon is inside the AppImage; extracting needs no FUSE.
  mkdir "$tmp/extract"
  icon=
  if (cd "$tmp/extract" && "$linux_bin" --appimage-extract 'usr/share/icons/hicolor/*/apps/*.png' >/dev/null 2>&1); then
    # The largest file is the sharpest size; ls -S would misread a name with a line break in it.
    icon_bytes=0
    for png in "$tmp"/extract/squashfs-root/usr/share/icons/hicolor/*/apps/*.png; do
      [ -f "$png" ] || continue
      bytes=$(wc -c <"$png" | tr -d ' ') || continue
      if [ "$bytes" -gt "$icon_bytes" ]; then icon=$png; icon_bytes=$bytes; fi
    done
  fi
  if [ -n "$icon" ]; then
    cp "$icon" "$linux_icon"
  else
    note "Could not read the icon out of the AppImage; the launcher entry will have none."
  fi

  exec_path=$linux_bin
  case $exec_path in *[' "\\$`']*) exec_path="\"$(printf '%s' "$exec_path" | sed 's/[\\"$`]/\\&/g')\"" ;; esac
  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Name=Ordewell\n'
    printf 'Comment=Turn one goal into an ordered plan of coding-agent tasks\n'
    printf 'Exec=%s %%U\n' "$exec_path"
    printf 'Icon=%s\n' "$BIN_NAME"
    printf 'Terminal=false\n'
    printf 'Categories=Development;\n'
    printf 'StartupWMClass=Ordewell\n'
  } > "$linux_entry"
  refresh_desktop_database

  say "Installed $label to $linux_bin"
  say "Start it from your applications menu, or:  $linux_bin"
  case ":${PATH:-}:" in
    *":$linux_prefix/bin:"*) ;;
    *) say "$linux_prefix/bin is not on your PATH; add it to start it as: $BIN_NAME" ;;
  esac
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    say "An AppImage needs FUSE 2 (libfuse2) to start. Install it, or run: $BIN_NAME --appimage-extract-and-run"
  fi
}

install_linux_deb() {
  command -v dpkg >/dev/null 2>&1 || die "--deb needs a Debian-based system with dpkg"
  # apt reads the file as its own unprivileged user.
  chmod 755 "$tmp"
  chmod 644 "$tmp/$asset"
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get install -y "$tmp/$asset"
  else
    run_privileged dpkg -i "$tmp/$asset"
  fi
  say "Installed $label with its package manager."
  say "Start it from your applications menu, or:  $BIN_NAME"
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
  trap - EXIT
  version=${ORDEWELL_VERSION:-}
  want_deb=0
  uninstall=0
  dry_run=0
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a value, for example --version 0.12.3"
        version=$2
        shift 2
        ;;
      --version=*) version=${1#--version=}; shift ;;
      --deb) want_deb=1; shift ;;
      --uninstall) uninstall=1; shift ;;
      --dry-run) dry_run=1; shift ;;
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

  case $(uname -s) in
    Darwin) platform=mac ;;
    Linux) platform=linux ;;
    *) die "this script is for macOS and Linux; on Windows use scripts/install/desktop.ps1" ;;
  esac
  case $(uname -m) in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) die "no Ordewell desktop build for the $(uname -m) architecture" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple-silicon Mac, and
  # the native build is the one to install.
  if [ "$platform" = mac ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$platform" = linux ] && [ "$arch" != x64 ]; then
    die "the Linux desktop builds are x64 only; this machine is $(uname -m)"
  fi
  if [ "$want_deb" = 1 ] && [ "$platform" != linux ]; then
    die "--deb is for Linux"
  fi

  linux_prefix=${ORDEWELL_INSTALL_DIR:-$HOME/.local}
  linux_bin=$linux_prefix/bin/$BIN_NAME
  linux_entry=$linux_prefix/share/applications/$BIN_NAME.desktop
  linux_icon=$linux_prefix/share/icons/hicolor/512x512/apps/$BIN_NAME.png

  # ---- uninstall ---------------------------------------------------------------

  if [ "$uninstall" = 1 ]; then
    if [ "$dry_run" = 1 ]; then
      say "Would remove what desktop.sh installed ($platform)."
      exit 0
    fi
    if [ "$platform" = mac ]; then uninstall_mac; else uninstall_linux; fi
    exit 0
  fi

  # ---- which file, from where --------------------------------------------------

  if [ "$platform" = mac ]; then
    asset=Ordewell-mac-$arch.dmg
  elif [ "$want_deb" = 1 ]; then
    asset=Ordewell-linux-x64.deb
  else
    asset=Ordewell-linux-x64.AppImage
  fi

  if [ -n "${ORDEWELL_DESKTOP_FROM:-}" ]; then
    [ -d "$ORDEWELL_DESKTOP_FROM" ] || die "ORDEWELL_DESKTOP_FROM is not a directory: $ORDEWELL_DESKTOP_FROM"
    source_desc="the directory $ORDEWELL_DESKTOP_FROM"
    asset_url=
    sums_url=
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
    say "Platform:  $platform $arch"
    say "File:      $asset"
    say "From:      $source_desc"
    if [ -n "$asset_url" ]; then
      say "Download:  $asset_url"
      say "Checksums: $sums_url"
    fi
    if [ "$platform" = mac ]; then
      say "Install:   $(mac_target_dir)/$APP"
    elif [ "$want_deb" = 1 ]; then
      say "Install:   the .deb, with apt or dpkg"
    else
      say "Install:   $linux_bin"
    fi
    exit 0
  fi

  # ---- fetch and verify --------------------------------------------------------

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ordewell-desktop.XXXXXX") || die "could not make a temporary directory"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  if [ -n "${ORDEWELL_DESKTOP_FROM:-}" ]; then
    [ -f "$ORDEWELL_DESKTOP_FROM/SHA256SUMS" ] || die "no SHA256SUMS in $ORDEWELL_DESKTOP_FROM (node scripts/desktop-release-assets.mjs <dir> writes it)"
    [ -f "$ORDEWELL_DESKTOP_FROM/$asset" ] || die "no $asset in $ORDEWELL_DESKTOP_FROM"
    cp "$ORDEWELL_DESKTOP_FROM/SHA256SUMS" "$tmp/SHA256SUMS"
    # A copy, so what is checked is what is installed.
    cp "$ORDEWELL_DESKTOP_FROM/$asset" "$tmp/$asset"
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
    note "ordewell-desktop: the checksum of $asset does not match SHA256SUMS."
    note "  expected $expected"
    note "  got      $actual"
    note "Nothing was installed. If a release was published while this ran, run it again."
    exit 1
  fi
  say "Checksum verified (sha256 $actual)"

  # The release's version, when SHA256SUMS can say it: the versioned name that
  # has the same hash as the fixed one.
  installed_version=$(awk -v hash="$expected" -v name="$asset" '$1 == hash && $2 != name { print $2 }' "$tmp/SHA256SUMS" \
    | sed -n "s/^Ordewell-\\(.*\\)-$platform-$arch\\.[A-Za-z]*\$/\\1/p" | head -n 1)
  label=Ordewell
  [ -z "$installed_version" ] || label="Ordewell $installed_version"

  # ---- install -----------------------------------------------------------------

  if [ "$platform" = mac ]; then
    install_mac
  elif [ "$want_deb" = 1 ]; then
    install_linux_deb
  else
    install_linux_appimage
  fi
}

main "$@"
