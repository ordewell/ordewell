import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Cpu, FileCode, Gauge, Hand } from 'lucide-react';
import type { TaskSummaryDensity } from '@ordewell/ui';
import { Badge, ChildPlanGlyph, Icon, RunnerBadge, effortLabel, modelShortLabel, runnerName } from '@ordewell/ui/design';
import type { LaneView } from './graphModel';

type AiLane = Extract<LaneView, { kind: 'ai' }>;

/** One way of writing an AI task's line: what each part says at that width. */
export interface AiForm {
  shortRunner: boolean;
  model: string;
  /** Null for a task with no effort; empty when the effort is down to its icon. */
  effort: string | null;
}

/**
 * The forms an AI task's line steps through as it runs short, widest first:
 * the effort shortens, then the model loses its provider and then its
 * trailing words, and only then does the runner's name shorten. A line still
 * too long keeps the effort's icon alone, which is shorter than any word the
 * model has left. Each part is cut at a word, never inside one; the whole of
 * each stays in its tooltip.
 */
export function aiForms(lane: AiLane): AiForm[] {
  const forms: AiForm[] = [{ shortRunner: false, model: lane.model, effort: lane.effort && effortLabel(lane.effort) }];
  const step = (change: Partial<AiForm>): void => {
    const last = forms[forms.length - 1]!;
    const next = { ...last, ...change };
    if (next.shortRunner !== last.shortRunner || next.model !== last.model || next.effort !== last.effort) forms.push(next);
  };
  if (lane.effort) step({ effort: effortLabel(lane.effort, { short: true }) });
  const bare = modelShortLabel(lane.model);
  step({ model: bare });
  // "deepseek-v4.1-flash" → "deepseek-v4.1…" → "deepseek…": a separator stays with the word after it.
  const words = bare.split(/(?=[-_ ])/);
  for (let n = words.length - 1; n >= 1; n--) step({ model: `${words.slice(0, n).join('')}…` });
  if (lane.runner && runnerName(lane.runner, { short: true }) !== runnerName(lane.runner)) step({ shortRunner: true });
  if (lane.effort) step({ effort: '' });
  return forms;
}

const overflows = (el: HTMLElement | null): boolean => !!el && el.scrollWidth > el.clientWidth + 0.5;

/**
 * Measured, not guessed: a model id has no width a rule could know. Each
 * layout that still overflows takes the next form, so a card settles in a
 * few frames before paint and a line that fits never shortens.
 */
function AiAssignment({ lane }: { lane: AiLane }): JSX.Element {
  const forms = useMemo(() => aiForms(lane), [lane]);
  const [level, setLevel] = useState(0);
  const line = useRef<HTMLSpanElement>(null);
  const model = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (level < forms.length - 1 && (overflows(line.current) || overflows(model.current))) setLevel(level + 1);
  }, [level, forms]);
  const form = forms[Math.min(level, forms.length - 1)]!;
  return (
    <span ref={line} className="graph-card-lane" data-lane="ai" data-form={level}>
      {lane.runner && <RunnerBadge runner={lane.runner} short={form.shortRunner} className="graph-card-runner" />}
      <span className="graph-card-part graph-card-model" title={`Model: ${lane.model}`}>
        <Icon icon={Cpu} size={14} />
        <span ref={model} className="graph-card-part-text">{form.model}</span>
      </span>
      {lane.effort && form.effort !== null && (
        <span className="graph-card-part graph-card-effort" title={`Thinking effort: ${effortLabel(lane.effort)}`}>
          <Icon icon={Gauge} size={14} />
          {form.effort && <span className="graph-card-part-text">{form.effort}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * A card's second line: who does the task. For an AI task the runner (its
 * colour beside its name), the model and the thinking effort, each behind its
 * own icon; for any other task who stands in the runner's place.
 */
export function CardAssignment({ lane, density }: { lane: LaneView; density: TaskSummaryDensity }): JSX.Element {
  switch (lane.kind) {
    case 'ai':
      // A new width or a new assignment measures again from the widest form.
      return <AiAssignment key={`${density}|${lane.runner}|${lane.model}|${lane.effort}`} lane={lane} />;
    case 'script':
      return (
        <span className="graph-card-lane" data-lane="script">
          <Badge icon={FileCode} className="graph-card-who" title="A script task: it runs the commands the plan holds, with no model">Script</Badge>
          {lane.command && <code className="graph-card-part-text graph-card-command" title={lane.command}>{lane.command}</code>}
        </span>
      );
    case 'user':
      return (
        <span className="graph-card-lane" data-lane="user">
          <Badge icon={Hand} className="graph-card-who" title="A manual task: you do it and mark it done">You</Badge>
        </span>
      );
    case 'delegated':
      return (
        <span className="graph-card-lane" data-lane="delegated">
          <Badge icon={ChildPlanGlyph} className="graph-card-who" title="A delegated task: a sub-planner plans and runs it as a child plan">Child plan</Badge>
          {lane.counts && <span className="graph-card-part-text" title={lane.counts}>{lane.counts}</span>}
        </span>
      );
  }
}
