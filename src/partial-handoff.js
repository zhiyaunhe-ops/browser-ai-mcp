'use strict';

const { z } = require('zod');

const text = z.string().trim().min(1);
const partialHandoff = z.object({
  reason: z.enum(['business_incomplete', 'missing_readback', 'criteria_mismatch'])
    .describe('Primary reason for unknown. Use business_incomplete if a required business step is still pending.'),
  remaining: text.describe('The specific unfinished operation, missing readback or mismatched criterion.'),
  observedSteps: z.array(z.object({ step: text, observationId: text })).default([])
    .describe('Intermediate results observed in this run, each linked to its readback at the time.')
});

module.exports = { partialHandoff };
