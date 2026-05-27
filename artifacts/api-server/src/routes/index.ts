import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import clubsRouter from "./clubs";
import eventsRouter from "./events";
import ridersRouter from "./riders";
import registrationsRouter from "./registrations";
import checkinsRouter from "./checkins";
import rfidRouter from "./rfid";
import motosRouter from "./motos";
import resultsRouter from "./results";
import seriesRouter from "./series";
import dashboardRouter from "./dashboard";
import timingRouter from "./timing";

const router: IRouter = Router();

router.use(timingRouter);
router.use(healthRouter);
router.use(authRouter);
router.use(clubsRouter);
router.use(eventsRouter);
router.use(ridersRouter);
router.use(registrationsRouter);
router.use(checkinsRouter);
router.use(rfidRouter);
router.use(motosRouter);
router.use(resultsRouter);
router.use(seriesRouter);
router.use(dashboardRouter);

export default router;
