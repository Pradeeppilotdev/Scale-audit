import fs from "node:fs";
import { createServer } from "node:http";

export function readConfig() {
  return fs.readFileSync("./config.json", "utf8");
}

export const server = createServer((_req, res) => res.end(readConfig()));
