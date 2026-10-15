import fs from "node:fs";

// Module-scope sync read at startup: low severity, not a request-path blocker.
export const version = fs.readFileSync("./package.json", "utf8");

export function readConfig() {
  return fs.readFileSync("./config.json", "utf8");
}
