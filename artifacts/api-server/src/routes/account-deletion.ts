import { Router } from "express";
import { sendDeletionRequestEmail } from "../lib/email";

const router = Router();

router.post("/account-deletion-request", async (req, res) => {
  const { email, reason } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const result = await sendDeletionRequestEmail({
    userEmail: email.toLowerCase().trim(),
    reason: reason ? String(reason).slice(0, 1000) : undefined,
  });

  if (!result.ok) {
    return res.status(500).json({ error: "Failed to send request. Please email support@rockymountainatv.com directly." });
  }

  return res.json({ ok: true });
});

export default router;
