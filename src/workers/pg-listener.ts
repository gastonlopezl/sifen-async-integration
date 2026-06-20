import pg from "pg";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const { Client } = pg;

type Handler = () => void;

// A dedicated Postgres connection that holds LISTEN on the worker's channels.
// This MUST be a direct connection, not a transaction pooler: PgBouncer in
// transaction mode drops the session that LISTEN depends on, so notifications
// silently never arrive. It reconnects with backoff if the connection drops, and
// re-issues every LISTEN on reconnect so a blip does not leave the worker deaf.
export class PgListener {
  private client: pg.Client | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  on(channel: string, handler: Handler): void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Listener stopped, create a new instance");
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: env.DATABASE_URL });

    client.on("notification", (msg) => {
      const set = this.handlers.get(msg.channel);
      if (!set) return;
      for (const handler of set) handler();
    });

    client.on("error", (err) => {
      logger.error("pg_listener.error", { reason: err.message });
      this.scheduleReconnect();
    });

    await client.connect();
    for (const channel of this.handlers.keys()) {
      await client.query(`LISTEN ${channel}`);
    }
    this.client = client;
    logger.info("pg_listener.ready", { channels: [...this.handlers.keys()].join(",") });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err) => {
        logger.error("pg_listener.reconnect_failed", {
          reason: err instanceof Error ? err.message : "unknown",
        });
        this.scheduleReconnect();
      });
    }, 2_000);
    this.reconnectTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}
