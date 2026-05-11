import { randomUUID, createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

export type TurnConfig = {
  sharedSecret: string;
  realm: string;
  urls: string[];
  ttlSec: number;
};

export function makeCredentials(cfg: TurnConfig): {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + cfg.ttlSec;
  const username = `${expiresAt}:${randomUUID()}`;
  const credential = createHmac("sha1", cfg.sharedSecret)
    .update(username)
    .digest("base64");
  return { urls: cfg.urls, username, credential, ttl: cfg.ttlSec };
}

export function registerTurnEndpoint(
  app: FastifyInstance,
  cfg: TurnConfig
): void {
  app.post(
    "/turn-credentials",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async () => makeCredentials(cfg)
  );
}
