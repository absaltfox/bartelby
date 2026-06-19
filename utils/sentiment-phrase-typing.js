'use strict';

// Surface-form heuristics for suggesting an entity_type from a sentiment
// phrase target. Rule-based v1 per S3.4 — LLM-driven typing is the future
// enhancement once curators report rule misses.
//
// Returns one of: 'person', 'place', 'event', 'organization', 'role',
// 'topic' (default). Curator overrides on the form.

const PERSON_PREFIX = /^(mr|mrs|ms|miss|dr|rev|prof|sir|lady|lord)\.?\s+/i;
const PLACE_TAIL = /\b(house|farm|street|road|river|lake|hill|valley|church|chapel|station|harbour|harbor|bridge|building)\b/i;
const EVENT_TAIL = /\b(meeting|wedding|funeral|battle|festival|election|ceremony|gathering|assembly|convention)\b/i;
const ORG_TAIL = /\b(society|company|board|council|committee|association|league|union|guild|firm|department)\b/i;
const ROLE_TAIL = /\b(teacher|superintendent|clerk|magistrate|minister|reverend|preacher|carpenter|blacksmith|farmer|merchant|doctor|nurse|secretary|treasurer|president)\b/i;

function suggestEntityType(phrase) {
  const normalized = String(phrase || '').trim().toLowerCase();
  if (!normalized) return 'topic';
  if (PERSON_PREFIX.test(normalized)) return 'person';
  if (ROLE_TAIL.test(normalized)) return 'role';
  if (PLACE_TAIL.test(normalized)) return 'place';
  if (EVENT_TAIL.test(normalized)) return 'event';
  if (ORG_TAIL.test(normalized)) return 'organization';
  return 'topic';
}

module.exports = { suggestEntityType };
