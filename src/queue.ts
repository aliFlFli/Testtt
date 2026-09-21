export interface QueueStats {
  running: number;
  waiting: number;
}

interface Job {
  run: () => void;
  position: (pos: number) => void;
}

/**
 * A tiny worker pool. Jobs run at most `concurrency` at a time; every waiting
 * job is notified of its current 1-based position whenever the queue changes.
 */
export class JobPool {
  private active = 0;
  private queue: Job[] = [];

  constructor(private readonly concurrency: number) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  stats(): QueueStats {
    return { running: this.active, waiting: this.queue.length };
  }

  enqueue<T>(task: () => Promise<T>, onPosition?: (pos: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        run: () => {
          task().then(resolve, reject).finally(() => {
            this.active--;
            this.pump();
          });
        },
        position: onPosition ?? (() => {}),
      };
      this.queue.push(job);
      this.refreshPositions();
      this.pump();
    });
  }

  private refreshPositions(): void {
    this.queue.forEach((job, idx) => job.position(idx + 1));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      this.refreshPositions();
      job.run();
    }
  }
}
