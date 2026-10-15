import fs from "node:fs";

export function readConfig() {
  return fs.readFileSync("./config.json", "utf8");
}
