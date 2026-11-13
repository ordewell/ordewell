import { describe, expect, it, vi } from 'vitest';
import type {
  AccountLimitsFrame, ChildTreeFrame, RunSnapshotFrame, SessionFrame, StreamStamp,
} from '../../daemonContract';
import type { SessionMessage, SessionNotice } from '../../services/SessionMessage';
import { EMPTY_RUN } from '../../services/runView';
import { DaemonStream, type DaemonFrame } from '../daemonStream';

interface Read {
  label: string;
  position?: StreamStamp;
}

/** What a surface was handed, in order: the read it redrew from, then each frame by its number. */
class Recorder extends DaemonStream<Read> {
  readonly drawn: string[] = [];

  protected tree(frame: ChildTreeFrame): void { this.drawn.push(`tree:${frame.children.length}`); }
  protected limits(frame: AccountLimitsFrame): void { this.drawn.push(`limits:${frame.stream}/${frame.revision}`); }
  protected snapshot(frame: RunSnapshotFrame): void { this.drawn.push(`snapshot:${frame.seq}`); }
  protected broadcast(frame: SessionMessage | SessionNotice): void {
    this.drawn.push(`${frame.type}:${(frame as Partial<StreamStamp>).seq ?? '-'}`);
  }
  protected loaded(state: Read): StreamStamp | undefined {
    this.drawn.push(`read:${state.label}`);
    return state.position;
  }
}

function follow(...reads: Array<Read | Error>) {
  const pending: Array<(read: Read | Error) => void> = [];
  const failed = vi.fn();
  const read = vi.fn(() => new Promise<Read>((resolve, reject) => {
    pending.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
  }));
  const stream = new Recorder(read, failed);
  return {
    stream,
    read,
    failed,
    feed: (...frames: DaemonFrame[]) => frames.forEach((frame) => stream.receive(frame)),
    /** Answers the oldest read still out with the next of `reads`, and lets it land. */
    answer: async () => {
      const next = reads.shift();
      if (!next) throw new Error('no read left to answer with');
      pending.shift()!(next);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

const output = (seq: number, stream = 'd1'): SessionFrame => ({ type: 'task_output', taskId: 't1', text: String(seq), stream, seq });
const status = (seq: number, stream = 'd1'): SessionFrame => ({ type: 'status_update', tasks: [], stream, seq });
const snapshot = (seq: number, stream = 'd1'): RunSnapshotFrame => ({ type: 'run_snapshot', sessionId: 's1', view: EMPTY_RUN, stream, seq });

describe('DaemonStream', () => {
  it('draws nothing before the read it follows, then every frame held behind it', async () => {
    const got = follow({ label: 'r1' });
    got.feed({ type: 'connected', sessionId: 's1' }, snapshot(0), output(1), output(2));
    expect(got.stream.drawn).toEqual([]);
    expect(got.read).toHaveBeenCalledTimes(1);

    await got.answer();
    got.feed(output(3));

    expect(got.stream.drawn).toEqual(['read:r1', 'snapshot:0', 'task_output:1', 'task_output:2', 'task_output:3']);
  });

  it('drops what the read already accounts for, by the position it read at, and copies of it after', async () => {
    const got = follow({ label: 'r1', position: { stream: 'd1', seq: 2 } });
    got.feed(snapshot(1), output(2), output(3));

    await got.answer();
    // A second socket lagging behind repeats what the read held.
    got.feed(output(2), output(4));

    expect(got.stream.drawn).toEqual(['read:r1', 'task_output:3', 'task_output:4']);
  });

  it('keeps every held frame when the read names a position on another stream, or none', async () => {
    const got = follow({ label: 'r1', position: { stream: 'old', seq: 9 } });
    got.feed(output(1), output(2));
    await got.answer();
    expect(got.stream.drawn).toEqual(['read:r1', 'task_output:1', 'task_output:2']);
  });

  it('reads again after a gap, and goes on from what that read returned', async () => {
    const got = follow({ label: 'r1' }, { label: 'r2', position: { stream: 'd1', seq: 4 } });
    got.feed(output(1));
    await got.answer();

    // 2 never came; 4 is in the second read.
    got.feed(output(3), output(4), output(5));
    expect(got.read).toHaveBeenCalledTimes(2);
    await got.answer();

    expect(got.stream.drawn).toEqual(['read:r1', 'task_output:1', 'read:r2', 'task_output:5']);
  });

  it('reads again when a second gap opens while a read is out, since that read may predate it', async () => {
    const got = follow({ label: 'stale' }, { label: 'r2' });
    got.feed(output(1), output(5));
    expect(got.read).toHaveBeenCalledTimes(1);

    await got.answer();
    expect(got.read).toHaveBeenCalledTimes(2);
    expect(got.stream.drawn).toEqual([]);

    await got.answer();
    expect(got.stream.drawn).toEqual(['read:r2', 'task_output:1', 'task_output:5']);
  });

  it('reads again when the daemon restarted, whose numbers start over', async () => {
    const got = follow({ label: 'r1' }, { label: 'r2' });
    got.feed(output(1), output(2));
    await got.answer();

    got.feed(output(1, 'd2'));
    expect(got.read).toHaveBeenCalledTimes(2);
    await got.answer();

    expect(got.stream.drawn).toEqual(['read:r1', 'task_output:1', 'task_output:2', 'read:r2', 'task_output:1']);
  });

  it('keeps what a failed read held, and reads again at the next frame', async () => {
    const away = new Error('daemon away');
    const got = follow(away, { label: 'r2' });
    got.feed(output(1));
    await got.answer();
    expect(got.failed).toHaveBeenCalledWith(away);
    expect(got.stream.drawn).toEqual([]);

    got.feed(output(2));
    await got.answer();

    expect(got.stream.drawn).toEqual(['read:r2', 'task_output:1', 'task_output:2']);
  });

  it('drops a status a later snapshot already accounts for, and keeps what the snapshot does not cover', async () => {
    const got = follow({ label: 'r1' });
    got.feed(snapshot(3));
    await got.answer();

    got.feed(status(2), output(1));

    expect(got.stream.drawn).toEqual(['read:r1', 'snapshot:3', 'task_output:1']);
  });

  it('applies an unnumbered frame, from a daemon older than the stamp, as it comes', async () => {
    const got = follow({ label: 'r1' });
    got.feed(output(1));
    await got.answer();
    got.feed({ type: 'task_output', taskId: 't1', text: 'old' });

    expect(got.stream.drawn).toEqual(['read:r1', 'task_output:1', 'task_output:-']);
  });

  it('passes the tree and account limits on unheld, each limit revision once per daemon', () => {
    const got = follow();
    const limits = (revision: number, stream = 'd1'): AccountLimitsFrame => ({ type: 'account_limits', sessionId: 's1', limits: [], stream, revision });
    got.feed(limits(1), limits(1), limits(0), limits(2), limits(1, 'd2'));
    got.feed({ type: 'child_tree', sessionId: 's1', children: [] });

    expect(got.stream.drawn).toEqual(['limits:d1/1', 'limits:d1/2', 'limits:d2/1', 'tree:0']);
    expect(got.read).not.toHaveBeenCalled();
  });

  it('draws nothing once closed, even from a read already out', async () => {
    const got = follow({ label: 'r1' });
    got.feed(output(1));
    got.stream.close();
    await got.answer();
    got.feed(output(2));

    expect(got.stream.drawn).toEqual([]);
    expect(got.read).toHaveBeenCalledTimes(1);
  });
});
