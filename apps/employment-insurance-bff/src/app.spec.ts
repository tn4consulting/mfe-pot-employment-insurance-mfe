import request from 'supertest';
import { createApp } from './app';
import type { EiApplicationInput } from './data';

const application: EiApplicationInput = {
  personal: {
    firstName: 'Alex',
    lastName: 'Chen',
    dateOfBirth: '1990-01-01',
    addressLine1: '123 Main St',
    city: 'Ottawa',
    province: 'ON',
    postalCode: 'K1A 0A1',
    phone: '6135550100',
    preferredLanguage: 'en',
  },
  separation: {
    employerName: 'Acme Co.',
    lastDayWorked: '2026-07-01',
    reasonCode: 'shortage_of_work',
    payRate: 25,
    payPeriod: 'hourly',
    jobTitle: 'Warehouse associate',
  },
  otherEmployment: { hadOtherEmployers: false },
  eligibility: {
    workersCompensation: false,
    pension: false,
    selfEmployedOrBusiness: false,
    inTrainingProgram: false,
  },
  availability: { availableImmediately: true, educationLevel: 'high_school' },
  directDeposit: { enrolling: false },
  declarationAccepted: true,
};

// The real JWKS-based JWT verification and the whoami response shape are
// both covered by shared-auth-server's own tests -- this only proves
// /api/whoami wires the middleware and handler together correctly.
jest.mock('@tn4consulting/shared-auth-server', () => ({
  verifyBearerToken:
    () =>
    (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
      if (req.headers.authorization === 'Bearer valid-token') {
        req.auth = { sub: 'citizen-abc123', name: 'Alex Chen', sin: '123-456-789', claims: [] };
        next();
        return;
      }
      res.status(401).json({ error: 'Invalid or expired token' });
    },
  whoamiHandler: (req: import('express').Request, res: import('express').Response) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Missing verified identity' });
      return;
    }
    res.json({ sub: req.auth.sub, name: req.auth.name, sinMasked: 'MASKED' });
  },
}));

describe('employment-insurance-bff', () => {
  const app = createApp();

  it('reports healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  // Exercises the real sessionCache (InMemorySessionCache here, since
  // REDIS_URL is unset in tests) -- the failure path (a genuinely
  // unreachable Redis returning 503) is verified live on kind instead,
  // scaling session-cache to 0 and confirming the pod drops out of
  // Ready/Service routing -- see mfe-pot/TODO.md's "Design principles"
  // section.
  it('reports ready when its own sessionCache round-trip succeeds', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('rejects an application missing applicantSub', async () => {
    const res = await request(app).post('/api/applications').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an application missing the declaration acceptance', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-001', application: { ...application, declarationAccepted: false } });
    expect(res.status).toBe(400);
  });

  it('rejects an application missing separation.payRate/payPeriod (used to 500 instead of 400)', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-001', application: { declarationAccepted: true } });
    expect(res.status).toBe(400);
  });

  it('creates a claim on application, deriving the weekly benefit from the submitted rate of pay', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-001', application });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applicantSub: 'mock-citizen-001', status: 'approved' });
    // $25/hr * 37.5 hrs/week * 55% = $515.625, rounded to 2 decimals.
    expect(res.body.weeklyBenefitAmount).toBe(515.63);
    expect(res.body.application).toMatchObject({ declarationAccepted: true });
  });

  it('returns 404 when there is no claim on file', async () => {
    const res = await request(app).get('/api/claims').query({ applicantSub: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('returns the most recent claim for an applicant', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-002', application });

    const res = await request(app).get('/api/claims').query({ applicantSub: 'mock-citizen-002' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it('rejects a report missing required fields', async () => {
    const res = await request(app).post('/api/reports').send({ claimId: 'claim-1' });
    expect(res.status).toBe(400);
  });

  it('submits a biweekly report', async () => {
    const res = await request(app).post('/api/reports').send({
      claimId: 'claim-1',
      applicantSub: 'mock-citizen-001',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-14',
      workedHours: 0,
      earnings: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ claimId: 'claim-1', applicantSub: 'mock-citizen-001' });
  });

  it('returns 404 for reporting status when there is no claim on file', async () => {
    const res = await request(app).get('/api/reporting-status').query({ applicantSub: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('reports a not-yet-due status anchored on the claim date when no reports exist', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-003', application });

    const res = await request(app)
      .get('/api/reporting-status')
      .query({ applicantSub: 'mock-citizen-003' });

    expect(res.status).toBe(200);
    expect(res.body.claimId).toBe(created.body.id);
    expect(res.body.status).toBe('not_yet_due');
    expect(res.body.daysUntilDue).toBeGreaterThan(3);
  });

  it('advances the due date past the most recently reported period', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ applicantSub: 'mock-citizen-004', application });
    const claimId = created.body.id as string;

    const farFutureEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request(app).post('/api/reports').send({
      claimId,
      applicantSub: 'mock-citizen-004',
      periodStart: '2026-07-01',
      periodEnd: farFutureEnd,
      workedHours: 0,
      earnings: 0,
    });

    const res = await request(app)
      .get('/api/reporting-status')
      .query({ applicantSub: 'mock-citizen-004' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_yet_due');
    expect(res.body.daysUntilDue).toBeGreaterThan(14);
  });

  it('returns the verified identity for /api/whoami', async () => {
    const res = await request(app).get('/api/whoami').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: 'citizen-abc123', name: 'Alex Chen', sinMasked: 'MASKED' });
  });

  it('rejects /api/whoami without a valid bearer token', async () => {
    const res = await request(app).get('/api/whoami');
    expect(res.status).toBe(401);
  });

  it('clears claims for a sub after /api/reset', async () => {
    await request(app).post('/api/applications').send({ applicantSub: 'mock-citizen-reset', application });

    const resetRes = await request(app).post('/api/reset');
    expect(resetRes.status).toBe(204);

    const res = await request(app).get('/api/claims').query({ applicantSub: 'mock-citizen-reset' });
    expect(res.status).toBe(404);
  });
});

describe('employment-insurance-bff error handling', () => {
  // A rejected sessionCache call (the real-world shape of "Redis is
  // unreachable") should degrade gracefully, not surface Express's bare
  // default 500 HTML page -- see app.ts's own last-resort error handler
  // comment and mfe-pot/TODO.md's "Design principles" section,
  // principle 5. jest.resetModules() + a fresh require is safe here (no
  // React involved, unlike a frontend spec) -- see shared-observability's
  // own spec file for the identical pattern.
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns a degraded 503 envelope, not a bare 500, when sessionCache rejects', async () => {
    jest.doMock('./config', () => ({
      sessionCache: {
        getJson: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        setJson: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        reset: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        buildKey: (...parts: string[]) => parts.join(':'),
      },
      mockIdp: { jwksUrl: 'http://localhost/jwks', issuer: 'http://localhost', audience: 'test' },
    }));

    const { createApp } = require('./app');
    const app = createApp();

    const res = await request(app).get('/api/claims').query({ applicantSub: 'anyone' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Service temporarily unavailable', degraded: true });
  });
});
