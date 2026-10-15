import express from "express";

// TODO: add a /health endpoint (this comment must not suppress the finding).
// Also we should handle process.on("SIGTERM") at some point (comment only).
const app = express();

app.get("/users", (req, res) => {
  res.json([]);
});

app.listen(3000);
