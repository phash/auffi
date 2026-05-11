import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const app = await createServer({ port, host });
await app.listen({ port, host });
console.log(`Listening on ${host}:${port}`);
