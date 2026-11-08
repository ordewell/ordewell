/**
 * A request's path and query as a fake daemon pins it, without the workspace a
 * live route carries: the client names the cwd it ran from, and what a command
 * test pins is what it asked for. apiClient.test.ts pins the workspace itself.
 */
export function wireRoute(url: string | undefined): string {
  return (url ?? '').replace(/([?&])workspace=[^&]*(&|$)/, (_match, lead: string, tail: string) => (tail ? lead : ''));
}
