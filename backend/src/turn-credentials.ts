import { randomUUID, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export type TurnConfig = {
  sharedSecret: string;
  realm: string;
  urls: string[];
  ttlSec: number;
  allowedOrigins: string[];
};

export function makeCredentials(cfg: TurnConfig): {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + cfg.ttlSec;
  const username = `${expiresAt}:${randomUUID()}`;
  // coturn use-auth-secret requires HMAC-SHA1 per RFC 5766 §10.2 — SHA-256 is not supported
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
    async (req: FastifyRequest, reply: FastifyReply) => {
      const origin = req.headers.origin as string | undefined;
      if (!origin || !cfg.allowedOrigins.includes(origin)) {
        return reply.status(403).send({ error: "origin not allowed" });
      }
      return makeCredentials(cfg);
    }
  );
}
