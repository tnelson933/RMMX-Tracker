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
import desktopRouter from "./desktop";
import practiceRouter from "./practice";
import ridersRouter from "./riders";
import clubsRouter from "./clubs";
import resultsRouter from "./results";
import seriesRouter from "./series";
import pointsTablesRouter from "./points-tables";
import dashboardRouter from "./dashboard";
import discountCategoriesRouter from "./discount-categories";
import stripeRouter from "./stripe";

const router = Router();

router.use(healthRouter);
router.use(statusRouter);
router.use(desktopRouter);
router.use(authRouter);
router.use(eventsRouter);
router.use(checkinsRouter);
router.use(registrationsRouter);
router.use(rfidRouter);
router.use(motosRouter);
router.use(timingRouter);
router.use(practiceRouter);
router.use(ridersRouter);
router.use(clubsRouter);
router.use(resultsRouter);
router.use(seriesRouter);
router.use(pointsTablesRouter);
router.use(dashboardRouter);
router.use(discountCategoriesRouter);
router.use(stripeRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;
