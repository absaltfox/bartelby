'use strict';

const KNOWLEDGE_AUTO_APPROVE_THRESHOLD = 0.85;
const CITATION_APPROVAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

function normalizeConfidence(value, fallback = 0.8) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function deriveCitationApproval(confidence, explicitStatus = null) {
  if (explicitStatus === CITATION_APPROVAL_STATUSES.APPROVED) {
    return {
      approvalStatus: CITATION_APPROVAL_STATUSES.APPROVED,
      approvalMethod: 'manual'
    };
  }

  if (explicitStatus === CITATION_APPROVAL_STATUSES.REJECTED) {
    return {
      approvalStatus: CITATION_APPROVAL_STATUSES.REJECTED,
      approvalMethod: 'manual'
    };
  }

  if (explicitStatus === CITATION_APPROVAL_STATUSES.PENDING) {
    return {
      approvalStatus: CITATION_APPROVAL_STATUSES.PENDING,
      approvalMethod: null
    };
  }

  const normalizedConfidence = normalizeConfidence(confidence);
  if (normalizedConfidence >= KNOWLEDGE_AUTO_APPROVE_THRESHOLD) {
    return {
      approvalStatus: CITATION_APPROVAL_STATUSES.APPROVED,
      approvalMethod: 'auto'
    };
  }

  return {
    approvalStatus: CITATION_APPROVAL_STATUSES.PENDING,
    approvalMethod: null
  };
}

module.exports = {
  KNOWLEDGE_AUTO_APPROVE_THRESHOLD,
  CITATION_APPROVAL_STATUSES,
  deriveCitationApproval,
  normalizeConfidence
};
