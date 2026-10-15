import express from "express";

const app = express();

app.get("/users", (req, res) => {
  res.json([]);
});

app.listen(3000);
