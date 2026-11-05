#!/usr/bin/env pwsh
# The shim npm writes beside claude.cmd, cut to what the fake needs. Ordewell
# starts it when the .cmd cannot carry a prompt: cmd.exe drops everything after
# a line break (ADR-0010).
$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
& node "$basedir/fake-claude.mjs" $args
exit $LASTEXITCODE
