#!/usr/bin/env bash
# Publish a rendered formula, and the cask when asked, to ordewell/homebrew-tap
# in one commit (ADR-0063 H11, ADR-0065 C8). release.yml's homebrew job and the
# manual re-publish, homebrew-publish.yml, both run this, so a fix to how the
# tap is written reaches both.
#
#   scripts/publish-tap.sh <rendered> <version> [--cask]
#
# <rendered> is render-package-manifests.mjs's --out folder. --cask is the
# caller's to decide: only a notarized desktop build has a cask Homebrew will
# install. The credential comes from the environment, HOMEBREW_TAP_TOKEN over
# HTTPS or else HOMEBREW_TAP_DEPLOY_KEY over SSH, and is handed to the clone and
# the push alone: it is never written to the clone's .git/config, put on a
# command line or printed. Re-run for a version the tap already carries, it
# changes nothing and pushes nothing.
#
# ORDEWELL_TAP_TEST_URL replaces the tap's URL, for the tests alone.
set -euo pipefail

usage() {
  echo "usage: scripts/publish-tap.sh <rendered> <version> [--cask]" >&2
  exit 2
}
[ $# -eq 2 ] || [ $# -eq 3 ] || usage
rendered=$1
version=$2
cask=false
if [ $# -eq 3 ]; then
  [ "$3" = --cask ] || usage
  cask=true
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "\"$version\" is not a version of the form x.y.z" >&2; exit 2; }
formula="$rendered/homebrew/Formula/ordewell.rb"
desktop_cask="$rendered/homebrew/Casks/ordewell-desktop.rb"
[ -f "$formula" ] || { echo "no rendered formula at $formula" >&2; exit 2; }
if [ "$cask" = true ] && [ ! -f "$desktop_cask" ]; then
  echo "--cask, but no rendered cask at $desktop_cask" >&2
  exit 2
fi
# The formula has no version line (Homebrew scans it from the archive URLs), so this release's
# version is what its archive URLs carry.
grep -q "^ *url \".*/ordewell-${version//./\\.}-[a-z0-9-]*\.tar\.gz\"$" "$formula" || { echo "$formula is not Ordewell $version" >&2; exit 2; }

# The clone and the key live here and go on any exit, failed or not.
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/homebrew-tap.XXXXXX")
trap 'rm -rf "$work"' EXIT
tap="$work/tap"
# A missing credential fails at once rather than waiting on a prompt.
export GIT_TERMINAL_PROMPT=0

if [ -n "${HOMEBREW_TAP_TOKEN:-}" ]; then
  url=${ORDEWELL_TAP_TEST_URL:-https://github.com/ordewell/homebrew-tap.git}
  # As actions/checkout sends it: a basic header scoped to the tap's URL. printf
  # is a builtin, so the token reaches base64 on its stdin, not its arguments.
  header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$HOMEBREW_TAP_TOKEN" | base64 | tr -d '\n')"
  # Neither credential goes on to git, the unused one included.
  unset HOMEBREW_TAP_TOKEN HOMEBREW_TAP_DEPLOY_KEY
  # Through git's GIT_CONFIG_* variables, for the one git command: `-c` would
  # put the header on a command line, and the clone's own config would keep it.
  # A token in the URL is no better: the push of release run 42286454425 had
  # nothing to send once that URL was reset out of the config.
  remote() {
    (
      n=${GIT_CONFIG_COUNT:-0}
      export GIT_CONFIG_COUNT=$((n + 1))
      export "GIT_CONFIG_KEY_$n=http.$url.extraheader"
      export "GIT_CONFIG_VALUE_$n=$header"
      git "$@"
    )
  }
elif [ -n "${HOMEBREW_TAP_DEPLOY_KEY:-}" ]; then
  url=${ORDEWELL_TAP_TEST_URL:-git@github.com:ordewell/homebrew-tap.git}
  # The key goes from the environment to a 0600 file through printf, a builtin,
  # so it is on no command line. ssh trusts only the host keys below: GitHub's
  # published ones, as api.github.com/meta `ssh_keys` and docs.github.com's
  # "GitHub's SSH key fingerprints" list them (fetched 2026-11-06; ED25519
  # SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU). A key scanned at run
  # time would trust whoever answered.
  ssh_dir="$work/ssh"
  mkdir -m 700 "$ssh_dir"
  (umask 077 && printf '%s\n' "$HOMEBREW_TAP_DEPLOY_KEY" > "$ssh_dir/key")
  chmod 600 "$ssh_dir/key"
  unset HOMEBREW_TAP_DEPLOY_KEY
  cat > "$ssh_dir/known_hosts" <<'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
HOSTS
  export GIT_SSH_COMMAND="ssh -i '$ssh_dir/key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$ssh_dir/known_hosts'"
  remote() { git "$@"; }
else
  echo "neither HOMEBREW_TAP_TOKEN nor HOMEBREW_TAP_DEPLOY_KEY is set" >&2
  exit 2
fi

remote clone --quiet --depth 1 "$url" "$tap"
mkdir -p "$tap/Formula"
cp "$formula" "$tap/Formula/ordewell.rb"
git -C "$tap" add Formula/ordewell.rb
if [ "$cask" = true ]; then
  mkdir -p "$tap/Casks"
  cp "$desktop_cask" "$tap/Casks/ordewell-desktop.rb"
  git -C "$tap" add Casks/ordewell-desktop.rb
fi
# The cask was `ordewell` until the formula took the name (ADR-0065 C8): once
# `ordewell-desktop` is in the tap the old file goes, and cask_renames.json, at
# the tap's root as Homebrew reads it, moves an installed `ordewell` cask to
# `ordewell-desktop` on upgrade. The rename waits for the new cask, since
# Homebrew needs its target to exist in the same tap.
if [ -f "$tap/Casks/ordewell-desktop.rb" ]; then
  git -C "$tap" rm --quiet --ignore-unmatch Casks/ordewell.rb
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const renames = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    renames.ordewell = "ordewell-desktop";
    fs.writeFileSync(file, JSON.stringify(renames, null, 2) + "\n");
  ' "$tap/cask_renames.json"
  git -C "$tap" add cask_renames.json
fi
if git -C "$tap" diff --cached --quiet; then
  echo "the tap already carries Ordewell ${version}"
  exit 0
fi
# Who commits, from the environment, so the clone's config holds nothing of it.
export GIT_AUTHOR_NAME='github-actions[bot]' GIT_COMMITTER_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
git -C "$tap" commit --quiet -m "Ordewell ${version}"
remote -C "$tap" push --quiet origin HEAD
echo "published Ordewell ${version} to the tap"
