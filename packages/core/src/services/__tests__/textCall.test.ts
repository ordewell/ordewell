import { describe, expect, it } from 'vitest';
import { writtenToolCall } from '../textCall';

const OFFERED = new Set(['message_task', 'read_file', 'task_complete']);
const found = (text: string) => writtenToolCall(text, OFFERED);

describe('a tool call written out as text', () => {
  it.each([
    ['the <tool_call> block', 'Done.\n<tool_call>\n{"name":"task_complete","arguments":{}}\n</tool_call>', 'task_complete'],
    ['a DSML invoke, as DeepSeek wrote it', '<｜DSML｜ invoke name="message_task">\n<｜DSML｜ parameter name="task">task-7</｜DSML｜ parameter>\n</｜DSML｜ invoke>', 'message_task'],
    ['a DSML function_calls wrapper around its invoke', '<｜DSML｜function_calls>\n<｜DSML｜invoke name="message_task">\n<｜DSML｜parameter name="id">task-7</｜DSML｜parameter>', 'message_task'],
    ['an ASCII-pipe DSML', 'Sending it.\n<|DSML|invoke name="read_file">\n</|DSML|invoke>', 'read_file'],
    ['a bare <invoke> block', 'I will tell it.\n<invoke name="message_task">\n<parameter name="task">task-7</parameter>\n</invoke>', 'message_task'],
    ['an <invoke> inside <function_calls>', '<function_calls>\n<invoke name="read_file">\n<parameter name="path">a.ts</parameter>\n</invoke>\n</function_calls>', 'read_file'],
    ['an <invoke> behind a namespace prefix', '<ns:function_calls>\n<ns:invoke name="read_file">\n</ns:invoke>', 'read_file'],
    ['a bare JSON object that is the whole reply', '{"name":"message_task","arguments":{"task":"task-7","text":"hi"}}', 'message_task'],
    ['the same in a fence that is the whole reply', '```json\n{"name": "message_task", "arguments": {"task": "task-7"}}\n```', 'message_task'],
    ['a JSON call with parameters for its key', '{"name":"read_file","parameters":{"path":"a.ts"}}', 'read_file'],
    ['a JSON call in the tool_calls envelope', '{"tool_calls":[{"type":"function","function":{"name":"message_task","arguments":"{}"}}]}', 'message_task'],
    ['a call cut off before it closes', '<invoke name="message_task">\n<parameter name="text">hel', 'message_task'],
  ])('is found: %s', (_label, text, name) => {
    expect(found(text)).toBe(name);
  });

  it.each([
    ['prose naming a tool', 'I will use message_task to tell task-7, and read_file first.'],
    ['prose naming the syntax', 'A model may write an <invoke> block or a <tool_call> block instead of a real call.'],
    ['an invoke mentioned mid-sentence', 'The reply held <invoke name="message_task"> as text, which I fixed.'],
    ['an invoke in an inline code span', 'Do not write `<invoke name="message_task">` in your reply.'],
    ['a fenced code sample in an answer', 'Call it like this:\n\n```xml\n<invoke name="message_task">\n<parameter name="task">task-7</parameter>\n</invoke>\n```\n\nThat sends the note.'],
    ['a fenced JSON sample with prose around it', 'The tool takes:\n\n```json\n{"name":"message_task","arguments":{"task":"task-7"}}\n```\n\nPass the task id.'],
    ['a JSON call quoted in a sentence', 'Earlier I sent {"name":"message_task","arguments":{"task":"task-7"}} and it landed.'],
    ['a quoted earlier call', '> <invoke name="message_task">\n> <parameter name="task">task-7</parameter>\n\nThat is what I sent before; it landed.'],
    ['a call to a tool the turn did not offer', '<invoke name="launch_missiles">\n</invoke>'],
    ['a JSON call to a tool the turn did not offer', '{"name":"launch_missiles","arguments":{}}'],
    ['a plan envelope', '{"tasks":[{"id":"a","name":"read_file"}]}'],
    ['a JSON object with a name that is not a call', '{"name":"message_task","owner":"alice"}'],
    ['an invoke with no tool name', '<invoke>\n</invoke>'],
  ])('is left alone: %s', (_label, text) => {
    expect(found(text)).toBeUndefined();
  });
});
