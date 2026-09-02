import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const app = await createServer({ port, host });
await app.listen({ port, host });
app.log.info({ host, port }, "server listening");

// `docker stop` sends SIGTERM and Node's default disposition exits at once,
// skipping every onClose hook (sweep + purge timers, db.close, the WS close
// frames @fastify/websocket sends its clients): peers got a TCP reset on
// every deploy and SQLite relied on WAL crash-recovery. Close cleanly, with
// a hard deadline inside Docker's 10 s stop grace so a wedged client cannot
// hold the container until it is SIGKILLed anyway.
const SHUTDOWN_DEADLINE_MS = 8_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}
