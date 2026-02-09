import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { buildServer } from "./server.js";

// Load env in a forgiving way:
// - The API is typically run with cwd=`apps/api`, but env files often live at repo root.
// - We try both locations without overriding existing env vars.
const candidates = [
  ".env",
  "env.example",
  path.resolve("..", "..", ".env"),
  path.resolve("..", "..", "env.example")
];

for (const p of candidates) {
  if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
}

const port = Number(process.env.PORT ?? 4000);
const host = "0.0.0.0";

const server = await buildServer();
await server.listen({ port, host });

server.log.info({ port }, "api listening");

