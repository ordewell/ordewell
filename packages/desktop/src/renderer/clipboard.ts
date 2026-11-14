/**
 * The system clipboard's text, through main (`window.ordewell.clipboard`):
 * the page has no web clipboard permission, so `navigator.clipboard` is always
 * refused here (security.ts). Each call rejects with the reason, worded for
 * the user, so a caller can say why nothing was copied or pasted.
 */

export async function readClipboardText(): Promise<string> {
  const result = await window.ordewell.clipboard.readText();
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

export async function writeClipboardText(text: string): Promise<void> {
  const result = await window.ordewell.clipboard.writeText(text);
  if (!result.ok) throw new Error(result.message ?? 'The clipboard could not be written.');
}
