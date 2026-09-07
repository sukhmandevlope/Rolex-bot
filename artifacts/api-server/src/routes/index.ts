import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sandboxPaymentRouter from "./sandbox-payment";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sandboxPaymentRouter);

export default router;
