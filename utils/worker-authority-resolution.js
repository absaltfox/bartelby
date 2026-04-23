'use strict';

const logger = require('./logger');
const { ensureEntityAuthority } = require('./authority-resolution');

function makeAuthorityResolutionLogger(job, authorityResolutionJobs) {
  return async function logLine(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await authorityResolutionJobs.appendLog(job.id, line);
  };
}

async function resolveJobEntityIds(job, entities) {
  const { authorityResolutionJobs } = require('../database/db');
  const explicitIds = authorityResolutionJobs.parseEntityIds(job);
  if (explicitIds.length) return explicitIds;

  const rows = await entities.getAll(job.batch_size || 100, 0);
  return rows
    .filter((entity) => !Number.isInteger(entity.authority_id))
    .slice(0, job.batch_size || 100)
    .map((entity) => entity.id);
}

async function runAuthorityResolutionWorkerCycle() {
  const { authorityResolutionJobs, entities } = require('../database/db');
  const job = await authorityResolutionJobs.claimNextQueued();
  if (!job) return;

  const logLine = makeAuthorityResolutionLogger(job, authorityResolutionJobs);
  let processedCount = 0;
  let resolvedCount = 0;

  try {
    const entityIds = await resolveJobEntityIds(job, entities);
    await logLine(`Starting authority resolution for ${entityIds.length} entity record(s).`);

    for (const entityId of entityIds) {
      processedCount += 1;
      const entity = await entities.getById(entityId);
      if (!entity) {
        await logLine(`Skipping missing entity #${entityId}.`);
        continue;
      }
      if (Number.isInteger(entity.authority_id)) {
        await logLine(`Skipping entity #${entity.id} (${entity.canonical_name}) — authority already assigned.`);
        continue;
      }

      const outcome = await ensureEntityAuthority(entity);
      if (outcome && outcome.authority) {
        resolvedCount += 1;
        await logLine(
          `Resolved entity #${entity.id} (${entity.canonical_name}) to authority #${outcome.authority.id} `
          + `(${outcome.authority.canonical_name}) via ${outcome.matchMethod}.`
        );
      }
    }

    await authorityResolutionJobs.markDone(job.id, { processedCount, resolvedCount });
    void logger.info('worker', 'Authority resolution job completed.', {
      jobType: 'authority_resolution',
      jobId: job.id,
      processedCount,
      resolvedCount
    });
  } catch (err) {
    await authorityResolutionJobs.markFailed(job.id, err.message);
    void logger.error('worker', 'Authority resolution job failed.', {
      jobType: 'authority_resolution',
      jobId: job.id,
      error: err.message
    });
  }
}

module.exports = {
  runAuthorityResolutionWorkerCycle
};
