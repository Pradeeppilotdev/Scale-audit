import fs from "node:fs";

// The file name contains "api" as a substring but it is not a request path.
// It must not be treated as a hot path.
export function capitalize(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Not a request path either.
export function loadLocal() {
  return fs.readFileSync("./local.json", "utf8");
}
