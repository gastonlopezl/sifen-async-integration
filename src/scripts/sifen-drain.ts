import { logger } from "@/lib/logger";
import { PgListener } from "@/workers/pg-listener";
import { SifenDispatcher } from "@/workers/dispatcher";

// Manual emission trigger. Drains the queue of 'queued' documents ONCE and exits.
// This is the only path that sends to SET when SIFEN_AUTO_DISPATCH is false.
//
// The reason it exists: when the deploy's egress path to SET is not good (or you
// are not sure it is), letting the worker auto-retry against SET is harmful. It
// generates a storm of silent timeouts and re-queues forever. So the worker runs
// in manual-only mode and a human pushes the backlog with this script, once the
// egress path is known to work:
//
//   npm run drain
//
// One pass. No timers, no listeners, no auto-retry. Documents that fail on a
// timeout return to 'queued' and you decide whether to run it again.
async function main(): Promise<void> {
  // The dispatcher needs a listener instance to construct, but drainOnce never
  // calls .start() on it, so no realtime connection is opened.
  const listener = new PgListener();
  const dispatcher = new SifenDispatcher(listener);

  logger.info("drain.start");
  await dispatcher.drainOnce();
  logger.info("drain.done");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error("drain.fatal", { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
