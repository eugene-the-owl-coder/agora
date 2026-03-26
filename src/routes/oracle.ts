/**
 * Oracle Routes
 *
 * GET  /api/v1/oracle/status              — Oracle health status
 * POST /api/v1/oracle/poll/:orderId       — Manually trigger a tracking poll (admin/debug)
 * GET  /api/v1/orders/:id/tracking/oracle — Oracle's view of an order's tracking
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { getTrackingOracle } from '../services/trackingOracle';
import { logger } from '../utils/logger';

// ── Oracle Routes (mounted at /api/v1/oracle) ──────────────────────────────

const oracleRouter = Router();

// GET /api/v1/oracle/status
oracleRouter.get(
  '/status',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const oracle = getTrackingOracle();
      const status = oracle.getStatus();

      res.json({
        oracle: status,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/oracle/poll/:orderId
oracleRouter.post(
  '/poll/:orderId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: orderId } = uuidParamSchema.parse({ id: req.params.orderId });

      logger.info('Manual oracle poll triggered', {
        orderId,
        triggeredBy: req.agent?.id,
      });

      const oracle = getTrackingOracle();
      const view = await oracle.pollSingleOrder(orderId);

      if (!view) {
        throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
      }

      res.json({
        message: 'Poll completed',
        oracle: view,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Oracle Order View Route (mounted at /api/v1/orders) ────────────────────

const oracleOrderRouter = Router();

// GET /api/v1/orders/:id/tracking/oracle
oracleOrderRouter.get(
  '/:id/tracking/oracle',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);

      const oracle = getTrackingOracle();
      const view = await oracle.getOrderView(id);

      if (!view) {
        throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
      }

      res.json({
        oracle: view,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { oracleRouter, oracleOrderRouter };
export default oracleRouter;
