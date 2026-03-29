/**
 * Call API routes.
 *
 * POST /api/calls          — validate order, create call_id, initiate Twilio outbound call
 * GET  /api/calls/:call_id — return call status and result
 *
 * Required logs:
 *   - Request validation and normalization
 *   - Call creation with Twilio request IDs
 */

import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { OrderRequestSchema, CreateCallRequest } from '../types';
import { CallSessionManager } from '../session/call-session-manager';
import { Logger } from '../logging/logger';

export function createCallRouter(
  sessionManager: CallSessionManager,
  parentLogger: Logger
): Router {
  const router = Router();
  const logger = parentLogger.child('api');

  // POST /api/calls — initiate a new call
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const correlationId = uuid();

    logger.info('api.call_request_received', 'Received new call request', {
      correlation_id: correlationId,
      body_keys: Object.keys(req.body),
    });

    // Validate request body
    const body = req.body as CreateCallRequest;

    if (!body.order) {
      logger.warn('api.validation_failed', 'Missing order field in request body', {
        correlation_id: correlationId,
      });
      res.status(400).json({ error: 'Missing "order" field' });
      return;
    }

    const orderResult = OrderRequestSchema.safeParse(body.order);

    if (!orderResult.success) {
      const issues = orderResult.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      logger.warn('api.validation_failed', 'Order validation failed', {
        correlation_id: correlationId,
        issues,
      });
      res.status(400).json({ error: 'Invalid order data', issues });
      return;
    }

    logger.info('api.order_validated', 'Order data validated successfully', {
      correlation_id: correlationId,
      customer_name: orderResult.data.customer_name,
      pizza_size: orderResult.data.pizza.size,
      budget_max: orderResult.data.budget_max,
    });

    // Initiate the call
    try {
      const callId = await sessionManager.initiateCall(
        orderResult.data,
        body.target_number
      );

      logger.info('api.call_initiated', `Call initiated: ${callId}`, {
        correlation_id: correlationId,
        call_id: callId,
        target_number: body.target_number ? '(custom)' : '(default)',
      });

      res.status(201).json({ call_id: callId, status: 'initiating' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('api.call_initiation_failed', `Failed to initiate call: ${message}`, {
        correlation_id: correlationId,
        error: message,
      });
      res.status(500).json({ error: 'Failed to initiate call', message });
    }
  });

  // GET /api/calls/:call_id — get call status
  router.get('/:call_id', (req: Request, res: Response): void => {
    const call_id = req.params.call_id as string;

    logger.debug('api.call_status_request', `Status request for call ${call_id}`, {
      call_id,
    });

    const session = sessionManager.getSession(call_id);

    if (!session) {
      logger.warn('api.call_not_found', `Call not found: ${call_id}`, { call_id });
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    res.json({
      call_id,
      status: session.phase,
      result: session.result ?? null,
    });
  });

  return router;
}
