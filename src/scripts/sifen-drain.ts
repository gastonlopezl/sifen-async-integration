import { logger } from "@/lib/logger";
import { PgListener } from "@/workers/pg-listener";
import { SifenDispatcher } from "@/workers/dispatcher";

// Backlog recovery tool. Drains the queue of 'queued' documents ONCE and exits.
// This is how you push the backlog when the circuit breaker is open
// (SIFEN_AUTO_DISPATCH=false). Production normally emits unattended.
//
// The reason it exists: during a SET outage or an egress regression, letting the
// worker keep auto-retrying is harmful. It generates a storm of silent timeouts
// and re-queues forever. You open the breaker to stop that, fix the path, then
// push the backlog by hand with this script once the egress is known to work:
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
