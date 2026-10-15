const fs = require("node:fs");

function main() {
  return fs.readFileSync("./package.json", "utf8");
}

module.exports = { main };
