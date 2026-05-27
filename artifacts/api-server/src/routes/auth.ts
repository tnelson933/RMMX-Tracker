import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.post("/auth/login", async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.email, email));
  const user = users[0];

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  (req.session as any).userId = user.id;

  if (rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  } else {
    req.session.cookie.expires = undefined; // session cookie — expires on browser close
  }

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clubId: user.clubId,
      createdAt: user.createdAt.toISOString(),
    },
    token: "session",
  });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const user = users[0];
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clubId: user.clubId,
    createdAt: user.createdAt.toISOString(),
  });
});

export default router;
