import express from "express";

export const jsonBodyParser = express.json({
  limit: "1mb",
  strict: true,
});
