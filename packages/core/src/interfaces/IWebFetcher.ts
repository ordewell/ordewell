import type { ToolOutcome } from './IFileSystem';

export interface IWebFetcher {
  confirm(url: string): Promise<boolean>;
  fetch(url: string): Promise<ToolOutcome>;
  /**
   * Optional web search. A fetcher without it makes the `web_search` tool
   * report itself unavailable rather than failing the turn — the same
   * degradation `fetch` already uses when no fetcher is wired at all.
   */
  search?(query: string): Promise<ToolOutcome>;
}
