import { logger } from "@/lib/logger";
import { PgListener } from "./pg-listener";
import { SifenDispatcher } from "./dispatcher";
import { SifenPoller } from "./poller";

// The long-lived worker. This is the process that MUST run on a box with a fixed
// Paraguayan outbound IP that SET has adhered (see README). It is deliberately NOT
// a Next route and NOT a serverless function: SET only answers callers whose
// source IP it has whitelisted, and serverless egress IPs rotate. One listener
// feeds both the dispatcher and the poller, and SIGTERM aborts in-flight SOAP
// requests so a deploy never strands a half-sent lote.
async function main(): Promise<void> {
  const listener = new PgListener();
  const dispatcher = new SifenDispatcher(listener);
  const poller = new SifenPoller(listener);

  // Register channel handlers before connecting so the first LISTEN covers both.
  await dispatcher.start();
  await poller.start();
  await listener.start();

  logger.info("worker.ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("worker.shutdown", { signal });
    await Promise.allSettled([dispatcher.stop(), poller.stop()]);
    await listener.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error("worker.fatal", { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
