import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { SessionStore } from "./codes.js";
import { registerSignaling } from "./signaling.js";

export type ServerConfig = {
  port: number;
  host: string;
};

export async function createServer(_cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.remoteAddress",
          "req.remotePort",
          'req.headers["x-forwarded-for"]',
          'req.headers["x-real-ip"]',
          "req.headers.cookie",
          "req.headers.authorization",
        ],
        remove: true,
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
          };
        },
      },
    },
  });
  await app.register(websocketPlugin);

  const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
  registerSignaling(app, store);

  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}
