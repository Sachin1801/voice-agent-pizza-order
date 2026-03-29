/**
 * Twilio webhook routes.
 *
 * POST /api/twilio/voice  — returns TwiML to open a media stream WebSocket
 * POST /api/twilio/status — receives call status callbacks
 *
 * Required logs:
 *   - TwiML generation
 *   - Call status updates from Twilio
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { CallSessionManager } from '../session/call-session-manager';
import { Logger } from '../logging/logger';

export function createTwilioWebhookRouter(
  sessionManager: CallSessionManager,
  parentLogger: Logger
): Router {
  const router = Router();
  const logger = parentLogger.child('twilio');

  // POST /api/twilio/voice — Twilio calls this when the outbound call connects
  router.post('/voice', (req: Request, res: Response): void => {
    const callSid = req.body.CallSid as string | undefined;
    const callStatus = req.body.CallStatus as string | undefined;

    logger.info('twilio.voice_webhook', 'Twilio voice webhook hit', {
      call_sid: callSid,
      call_status: callStatus,
      from: req.body.From,
      to: req.body.To,
    });

    // Return TwiML that opens a bidirectional media stream
    const wsUrl = `${config.publicWsBaseUrl}/api/twilio/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid || ''}" />
    </Stream>
  </Connect>
</Response>`;

    logger.info('twilio.twiml_generated', 'Generated TwiML with media stream', {
      call_sid: callSid,
      ws_url: wsUrl,
    });

    // Link the Twilio CallSid to our internal session
    if (callSid) {
      sessionManager.linkTwilioCallSid(callSid);
    }

    res.type('text/xml');
    res.send(twiml);
  });

  // POST /api/twilio/status — Twilio status callback
  router.post('/status', (req: Request, res: Response): void => {
    const callSid = req.body.CallSid as string | undefined;
    const callStatus = req.body.CallStatus as string | undefined;
    const duration = req.body.CallDuration as string | undefined;

    logger.info('twilio.status_callback', `Call status update: ${callStatus}`, {
      call_sid: callSid,
      call_status: callStatus,
      duration,
      direction: req.body.Direction,
      timestamp: req.body.Timestamp,
    });

    // Notify session manager of status changes
    if (callSid && callStatus) {
      sessionManager.handleTwilioStatus(callSid, callStatus);
    }

    res.sendStatus(200);
  });

  return router;
}
