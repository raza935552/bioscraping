// Minimal no-Redis scheduler. Each job runs on an interval under a MySQL
// named lock (GET_LOCK), so runs never overlap — not in this process, and not
// across processes if the worker is ever scaled to two boxes. A run that
// overshoots its interval is logged loudly instead of stacking.

import { withMysqlLock, type Connection } from "@biolinx/db";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  /** Run once immediately on boot (before the first interval elapses). */
  runOnBoot?: boolean;
  fn: () => Promise<void>;
}

export function startScheduler(conn: Connection, jobs: ScheduledJob[]): void {
  for (const job of jobs) {
    const tick = async () => {
      const started = Date.now();
      try {
        const result = await withMysqlLock(conn.pool, `job:${job.name}`, job.fn);
        if (result === null) {
          console.warn(`[scheduler] ${job.name}: previous run still holds the lock — skipped`);
          return;
        }
        const elapsed = Date.now() - started;
        if (elapsed > job.everyMs) {
          console.error(
            `[scheduler] ${job.name}: run took ${Math.round(elapsed / 1000)}s — longer than its ${Math.round(job.everyMs / 1000)}s interval`,
          );
        }
      } catch (err) {
        // Jobs own their failure reporting (fail-loud alerts); this is the backstop.
        console.error(`[scheduler] ${job.name} failed: ${(err as Error).message}`);
      }
    };
    if (job.runOnBoot) void tick();
    setInterval(tick, job.everyMs);
    console.log(`[scheduler] registered ${job.name} every ${Math.round(job.everyMs / 60000)}m`);
  }
}
