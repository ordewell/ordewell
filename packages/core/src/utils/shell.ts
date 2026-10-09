// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\r/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
