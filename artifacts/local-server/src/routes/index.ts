import { Router } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import eventsRouter from "./events";
import checkinsRouter from "./checkins";
import registrationsRouter from "./registrations";
import rfidRouter from "./rfid";
import motosRouter from "./motos";
import timingRouter from "./timing";
import statusRouter from "./status";

const router = Router();

router.use(healthRouter);
router.use(statusRouter);
router.use(authRouter);
router.use(eventsRouter);
router.use(checkinsRouter);
router.use(registrationsRouter);
router.use(rfidRouter);
router.use(motosRouter);
router.use(timingRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;
