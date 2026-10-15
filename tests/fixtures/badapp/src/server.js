const express = require("express");
const session = require("express-session");
const fs = require("fs");
const app = express();
const cache = new Map();
app.use(session({ secret: "x" }));
app.get("/users", async (req, res) => {
  const data = fs.readFileSync("./big.json", "utf8");
  res.json(JSON.parse(data));
});
app.listen(3000);
