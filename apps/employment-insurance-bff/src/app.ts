import cors from 'cors';
import express, { Express } from 'express';
import { verifyBearerToken, whoamiHandler } from '@tn4consulting/shared-auth-server';
import { mockIdp, sessionCache } from './config';
import { createClaim, createReport, EiApplicationInput, getClaim, getReports } from './data';
import { computeReportingStatus } from './reporting-status';

/**
 * Employment Insurance's own dedicated backend -- realistic shape for a
 * distinct bounded context (applications, claim status, biweekly
 * reporting). See CLAUDE.md's "Backends: BFF pattern" section.
 */
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Bare liveness check -- "the process is up," nothing more. Kept separate
  // from /ready below since a real readiness check (does this pod's own
  // sessionCache actually work right now) has a different failure mode: a
  // BFF that can't reach Redis is genuinely not ready to serve traffic,
  // but killing/restarting it (what a failing liveness probe triggers)
  // wouldn't fix a Redis-side outage -- see mfe-pot/TODO.md's "Design
  // principles" section, principle 3/4.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Real readiness check: a round-trip through this pod's own sessionCache
  // (Redis when REDIS_URL is set, always-succeeds in-memory otherwise --
  // see config.ts). A slow/unreachable Redis makes this pod fail
  // readiness, so Kubernetes stops routing it new traffic (via the
  // Service's endpoint list) without restarting it -- exactly the "not
  // ready to serve, but not crashed" distinction /health can't express on
  // its own.
  app.get('/ready', async (_req, res) => {
    try {
      await sessionCache.getJson(sessionCache.buildKey('readiness-probe'));
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not-ready', error: (err as Error).message });
    }
  });

  app.post('/api/applications', async (req, res) => {
    const { applicantSub, application } = req.body as {
      applicantSub?: string;
      application?: EiApplicationInput;
    };
    if (!applicantSub) {
      res.status(400).json({ error: 'applicantSub is required' });
      return;
    }
    if (!application || application.declarationAccepted !== true) {
      res.status(400).json({ error: 'application with declarationAccepted=true is required' });
      return;
    }
    // Only the two fields calculateWeeklyBenefitAmount() actually reads --
    // not a full schema check -- so a malformed application 400s cleanly
    // instead of throwing past this point (undefined.payRate) into an
    // unhandled 500.
    if (!application.separation || typeof application.separation.payRate !== 'number' || !application.separation.payPeriod) {
      res.status(400).json({ error: 'application.separation.payRate and payPeriod are required' });
      return;
    }
    res.status(201).json(await createClaim(applicantSub, application));
  });

  app.get('/api/claims', async (req, res) => {
    const applicantSub = req.query['applicantSub'];
    if (typeof applicantSub !== 'string') {
      res.status(400).json({ error: 'applicantSub query parameter is required' });
      return;
    }
    const claim = await getClaim(applicantSub);
    if (!claim) {
      res.status(404).json({ error: 'No claim on file' });
      return;
    }
    res.json(claim);
  });

  app.get('/api/reporting-status', async (req, res) => {
    const applicantSub = req.query['applicantSub'];
    if (typeof applicantSub !== 'string') {
      res.status(400).json({ error: 'applicantSub query parameter is required' });
      return;
    }
    const claim = await getClaim(applicantSub);
    if (!claim) {
      res.status(404).json({ error: 'No claim on file' });
      return;
    }
    res.json(computeReportingStatus(claim, await getReports(claim.id)));
  });

  app.post('/api/reports', async (req, res) => {
    const { claimId, applicantSub, periodStart, periodEnd, workedHours, earnings } = req.body as {
      claimId?: string;
      applicantSub?: string;
      periodStart?: string;
      periodEnd?: string;
      workedHours?: number;
      earnings?: number;
    };
    if (!claimId || !applicantSub || !periodStart || !periodEnd) {
      res
        .status(400)
        .json({ error: 'claimId, applicantSub, periodStart, and periodEnd are required' });
      return;
    }
    res
      .status(201)
      .json(
        await createReport(claimId, applicantSub, periodStart, periodEnd, workedHours ?? 0, earnings ?? 0),
      );
  });

  // Proves identity (including the SIN custom claim) actually propagated
  // from mock-idp through the browser and was independently verified here
  // -- see mfe-pot's plan doc. Mounted only on this one route, not globally:
  // the domain routes above are single-persona stub data not yet keyed by
  // sub (a bigger, separate scope item).
  app.get(
    '/api/whoami',
    verifyBearerToken({ jwksUrl: mockIdp.jwksUrl, issuer: mockIdp.issuer, audience: mockIdp.audience }),
    whoamiHandler,
  );

  // PoT-only, no auth -- unlocks a repeatable `pnpm demo:reset` (see
  // mfe-pot/TODO.md) by clearing this BFF's own Redis-backed state between
  // local/CI runs and live demos.
  app.post('/api/reset', async (_req, res) => {
    await sessionCache.reset();
    res.status(204).send();
  });

  // Last-resort error handler, not per-call-site try/catch: Express 5
  // (this app's version) auto-forwards a rejected async route handler's
  // promise here, including every sessionCache.getJson/setJson call above
  // -- so a Redis outage (the realistic failure mode, given InMemory-
  // SessionCache never rejects) surfaces as this typed, degraded JSON
  // envelope instead of Express's bare default 500 HTML page. See
  // mfe-pot/TODO.md's "Design principles" section, principle 5.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('employment-insurance-bff: unhandled request error:', err);
    res.status(503).json({ error: 'Service temporarily unavailable', degraded: true });
  });

  return app;
}
