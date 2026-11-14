---
status: accepted
---

# 0069 — Option+Left/Right moves by words over a private link to the user's zsh, and sends no bytes

## Problem

On macOS, Option+Left/Right moves by words in most terminals. In the desktop
terminal ([ADR-0062](../isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)
G11 puts the pty in main), two byte translations were shipped and withdrawn.
Meta+B/F deletes or inserts text in zsh's vi mode and in custom bindings, and
starts application shortcuts in vim and other programs. Plain arrows counted off
the screen misjudge words, wrapped lines, prompts and full-screen programs. The
counterexamples that withdrew them include vi command mode, `bindkey -s` macros,
a nested shell, vim, typeahead behind a running command, and SSH or tmux, where
the program reading the bytes is not the one that drew the screen. Since then
the renderer swallows the chord.

The underlying problem is that bytes go to whatever program reads the terminal,
and nothing the app sees says which program that is or what a key means to it.

## Decision

**The chord never becomes bytes. It is a request over a private socket to the
line editor of the user's own zsh, which moves only when it can show it is idle
at its top-level prompt; in every other case the chord does nothing, as
before.**

A shell that fits gets a fresh directory (mode 0700) holding a socket and a
`.zshenv`. It starts with `ZDOTDIR` pointing there. That `.zshenv` first puts
`ZDOTDIR` back as the user had it, so zsh reads the user's `.zprofile`, `.zshrc`
and `.zlogin` unchanged. It unsets the link's variables, connects with
`zsocket`, and watches the descriptor with `zle -F`. It binds no key and
replaces no widget. The renderer sends the direction over IPC, main asks the
shell, and the shell's handler runs a check widget. The move runs only once the
check passes, through the builtin widgets (`.backward-word`,
`.emacs-forward-word`, `.vi-backward-word`, `.vi-forward-word`, called with
`-f nolast`), so a user's override of those names is never invoked.

## Key properties

- **No bytes (W1).** Neither renderer nor main writes anything to the pty for the
  chord. A program that is not the linked zsh line editor (vim, less, `cat`, ssh,
  tmux, a nested shell, a running command) receives nothing.
- **Only where nothing is displaced (W2).** The link applies only on macOS, only
  for the file `/bin/zsh`, and only when none of `/etc/zshenv`,
  `/etc/zshenv.zwc`, `$ZDOTDIR/.zshenv` (or `$HOME/.zshenv`) and its `.zwc`
  exists. The link's `.zshenv` then has nothing to stand in for. No user file is
  read, written or wrapped.
- **Idle at the top-level prompt, or refused (W3).** The check requires all of:
  - `CONTEXT=start`;
  - no keys half read (`KEYS` empty);
  - no recursive edit;
  - `MARK >= 0` (no pending vi operator);
  - no suffix, no isearch match;
  - the handler called directly from zle;
  - a stock keymap (`main`, `emacs`, `viins`, `vicmd`);
  - a last widget that is not a search, completion, menu, expansion,
    named-command or recursive-edit widget.

  Anything else answers `no`.
- **Order kept (W4).** Main sends the request only after node-pty has written
  every key typed before the chord. It holds every key typed after it until the
  shell answers. zsh reads its terminal before it runs a watched descriptor's
  handler, so earlier keys are edited first. A pty whose write queue main cannot
  read refuses the move.
- **One shell, once (W5).** The server accepts one connection and removes its
  directory as it does. The shell unsets `ORDEWELL_WORD_SOCKET` before anything
  else runs, so a nested zsh, a subshell or a program finds no link to join.
- **Uncertain means nothing (W6).** In each of these cases the chord does nothing:
  - no answer within a short wait, after which the chord stays off until the
    shell next speaks, since it is not at its prompt;
  - a second chord while one is in flight;
  - a late `ready`, which main answers with `no`;
  - the alternate screen in xterm;
  - a link that failed to open;
  - a shell that never connected.

  The panel's banner says the chord does nothing until the tab's shell joins the
  link.

## The exchange

```
main  → zsh   req N l|r      after node-pty's queue is empty; later keys held
zsh   → main  no N           check failed (or not at the prompt)
zsh   → main  ready N        check passed
main  → zsh   go N           only for the request in flight that was asked
zsh           zle <builtin> -f nolast; zle -R
zsh   → main  done N         main releases the held keys
```

The shell drains to the newest request, so a burst of chords moves at most once
per answer. Main drops a chord pressed while one is in flight.

## Testing decisions

`packages/desktop/src/main/terminal/__tests__/wordLink.test.ts` runs the real
`WordLink` against a real zsh in a real pty (node-pty, skipped on Windows). It
covers:

- emacs, vi insert and vi command moves;
- typeahead around the chord, repeated and held chords;
- a custom accept-line widget;
- a running command, and `cat -v` receiving nothing;
- a nested `zsh -f` that sees no link;
- refusal in isearch, menu-select and a pending vi operator, each compared with
  the same keys typed without the chord;
- the user's startup files read and no variable left behind.

The fit (W2) and the protocol's refusals are unit-tested without a shell.
`e2e/wordChord.spec.ts` drives the chord through Electron and expects a move
exactly when W2 holds, or an untouched line when it does not.

## Out of scope

- bash, fish and other shells; a zsh other than `/bin/zsh`; a zsh with a
  zshenv; a shell inside SSH or tmux. All keep the swallow guard.
- Shift+Option selection, and Option+Backspace/Delete.

## Considered options

- **Meta+B/F bytes.** Rejected: their meaning depends on the keymap and the
  program, and they deleted text in vi mode and triggered vim's bindings.
- **Plain arrows counted off the screen.** Rejected: the screen does not say
  where a word starts in the shell's buffer, and a full-screen program or
  remote shell receives the arrows too.
- **A binding in the user's `.zshrc`, or a private escape sequence bound by an
  injected file.** Rejected: it changes user rc files, and an escape sequence
  is still bytes that every other program reads.
- **Wrapping a user's existing zshenv** (sourcing it from the link's own).
  Rejected for now: it changes the order and the `$0` and `ZDOTDIR` a user's
  zshenv sees. Such a shell keeps the guard instead.
- **Keep swallowing everywhere.** The fallback, kept for every case W2 and W3
  do not cover.

## Consequences

- A user with macOS's default shell and no zshenv gets word movement at the
  prompt. Everyone else gets what they had, and the banner says so.
- The check's denylist of widgets is the part to watch: a widget that opens its
  own minibuffer without one of those names would pass it. While
  `execute-named-cmd` reads its name, the check does not refuse, and the move
  moves the cursor only.
- Main reads node-pty's private write queue (`_writeStream._writeQueue`). If a
  node-pty upgrade changes it, the move is refused, not misordered.

## History

- 2026-11-14 — accepted.
