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
  /** Spends metered credit (Apify, Anthropic). Never runs on boot: the first run
   *  is anchored to the job's last run in sync_runs, and never sooner than
   *  SPEND_BOOT_GRACE_MS after a restart. Restarts neither add spend nor reset
   *  the daily clock, so frequent deploys can't starve the job. */
  spends?: boolean;
  fn: () => Promise<void>;
}

/** Minimum wait after a restart before a spending job may run. */
export const SPEND_BOOT_GRACE_MS = 60 * 60 * 1000;

/** Delay before a spending job's first run after boot. `msSinceLastRun` is null
 *  when the job has never run. */
export function firstSpendDelayMs(everyMs: number, msSinceLastRun: number | null, graceMs = SPEND_BOOT_GRACE_MS): number {
  const due = msSinceLastRun == null ? 0 : everyMs - msSinceLastRun;
  return Math.max(graceMs, due);
}

async function msSinceLastRun(conn: Connection, job: string): Promise<number | null> {
  // started_at is stored in UTC.
  const [rows] = await conn.pool.query("SELECT TIMESTAMPDIFF(SECOND, MAX(started_at), UTC_TIMESTAMP()) AS s FROM sync_runs WHERE job = ?", [job]);
  const s = (rows as Array<{ s: number | null }>)[0]?.s;
  return s == null ? null : Number(s) * 1000;
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
    if (job.spends) {
      void (async () => {
        let since: number | null = null;
        try {
          since = await msSinceLastRun(conn, job.name);
        } catch (err) {
          console.error(`[scheduler] ${job.name}: could not read last run (${(err as Error).message}); waiting a full interval`);
          since = 0;
        }
        const delay = firstSpendDelayMs(job.everyMs, since);
        console.log(`[scheduler] registered ${job.name} every ${Math.round(job.everyMs / 60000)}m (spends credit; first run in ${Math.round(delay / 60000)}m)`);
        setTimeout(() => {
          void tick();
          setInterval(tick, job.everyMs);
        }, delay);
      })();
      continue;
    }
    if (job.runOnBoot) void tick();
    setInterval(tick, job.everyMs);
    console.log(`[scheduler] registered ${job.name} every ${Math.round(job.everyMs / 60000)}m`);
  }
}
