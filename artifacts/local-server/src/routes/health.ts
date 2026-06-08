import { Router } from "express";
import { getDb } from "../db";

const router = Router();

router.get("/healthz", (_req, res) => {
  try {
    getDb().prepare("SELECT 1").get();
    res.json({ status: "ok", mode: "local" });
  } catch {
    res.status(503).json({ status: "error", mode: "local" });
  }
});

export default router;
