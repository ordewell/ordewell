/**
 * The built-in runner's own tools: one neutral set, the same for every model
 * (no todo, subagent, question or LSP tool: the plan covers those). The loop
 * hands a model `ordewellTools`' names, descriptions and `parameters`, and runs
 * each call through `runTool`, the one place a gate can ask first and the one
 * place output is capped.
 */
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { shellTool } from './shell';
import { writeTool } from './write';
import type { OrdewellTool } from './types';

export const ordewellTools: readonly OrdewellTool[] = [readTool, editTool, writeTool, shellTool, grepTool, globTool];

/** The tool a model named, or undefined for a name that is not in the set. */
export function findTool(name: string): OrdewellTool | undefined {
  return ordewellTools.find((tool) => tool.name === name);
}

export { runTool } from './run';
export type { GateDecision, ToolGate } from './run';
export { buildToolEnv } from './shellEnv';
export { capOutput, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './output';
export type { OrdewellTool, ToolContext, ToolEffect, ToolResult, ToolSchema } from './types';
export { editTool, globTool, grepTool, readTool, shellTool, writeTool };
