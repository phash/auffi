import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";

export type ServerConfig = {
  port: number;
  host: string;
};

export async function createServer(_cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocketPlugin);

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
