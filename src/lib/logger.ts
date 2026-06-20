// Minimal structured logger. Real deployments swap this for pino/winston, but
// the shape is the point: log an event name plus an allowlisted context object,
// never a whole request, error, or SOAP body, so certificate material, CDCs,
// and customer data cannot leak into logs.
type Context = Record<string, string | number | boolean | null | undefined>;

function emit(level: "info" | "warn" | "error", event: string, ctx: Context = {}): void {
  const line = JSON.stringify({ level, event, ...ctx, at: new Date().toISOString() });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  info: (event: string, ctx?: Context) => emit("info", event, ctx),
  warn: (event: string, ctx?: Context) => emit("warn", event, ctx),
  error: (event: string, ctx?: Context) => emit("error", event, ctx),
};
