const fs = require("node:fs");

function loadMany() {
  const a = fs.readFileSync("./a.json", "utf8");
  const b = fs.readFileSync("./b.json", "utf8");
  const c = fs.readFileSync("./c.json", "utf8");
  const d = fs.readFileSync("./d.json", "utf8");
  const e = fs.readFileSync("./e.json", "utf8");
  const f = fs.readFileSync("./f.json", "utf8");
  const g = fs.readFileSync("./g.json", "utf8");
  const h = fs.readFileSync("./h.json", "utf8");
  const i = fs.readFileSync("./i.json", "utf8");
  const j = fs.readFileSync("./j.json", "utf8");
  const k = fs.readFileSync("./k.json", "utf8");
  const l = fs.readFileSync("./l.json", "utf8");
  return [a, b, c, d, e, f, g, h, i, j, k, l];
}

module.exports = { loadMany };
