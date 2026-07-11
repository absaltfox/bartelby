'use strict';

const crypto = require('crypto');
const os = require('os');

const DEFAULT_BATCH_FINALIZATION_STALE_SECONDS = 10 * 60;
const PROCESS_BOOT_ID = typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : crypto.randomBytes(16).toString('hex');

function parseFinalizationStaleSeconds(envName, fallback = DEFAULT_BATCH_FINALIZATION_STALE_SECONDS) {
  const parsed = Number.parseInt(process.env[envName] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getFinalizationOwner(scope) {
  const machineId = String(
    process.env.FLY_MACHINE_ID
      || process.env.HOSTNAME
      || os.hostname()
      || 'unknown-machine'
  ).trim() || 'unknown-machine';
  const processGroup = String(process.env.FLY_PROCESS_GROUP || 'app').trim().toLowerCase() || 'app';
  return `${scope}:${processGroup}:${machineId}:pid:${process.pid}:boot:${PROCESS_BOOT_ID}`;
}

function isLostFinalizationClaimError(error) {
  if (error && error.code === 'LOST_FINALIZATION_CLAIM') return true;
  const message = error && error.message ? error.message : String(error || '');
  return /Lost(?: extraction)? finalization claim for batch job \d+\./.test(message);
}

module.exports = {
  DEFAULT_BATCH_FINALIZATION_STALE_SECONDS,
  getFinalizationOwner,
  isLostFinalizationClaimError,
  parseFinalizationStaleSeconds
};
