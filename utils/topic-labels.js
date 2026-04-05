'use strict';

async function applyHumanReadableTopicLabels({ collectionId, providerName, topics, assignments, documents }) {
  if (!providerName || !Array.isArray(topics) || topics.length === 0) {
    return topics || [];
  }

  try {
    const { generateTopicLabels } = require('./llm');
    const { labels, error } = await generateTopicLabels(providerName, topics, assignments, documents);

    if (error) {
      console.warn(`[analytics] topic label generation skipped for collection ${collectionId}: ${error.message}`);
      return topics;
    }

    const labelCount = Object.keys(labels || {}).length;
    if (!labelCount) {
      return topics;
    }

    console.log(`[analytics] generated ${labelCount} human-readable topic label(s) for collection ${collectionId}`);
    return topics.map((topic) => (
      labels[topic.topic_id]
        ? { ...topic, topic_label: labels[topic.topic_id] }
        : topic
    ));
  } catch (err) {
    console.warn(`[analytics] topic label generation failed for collection ${collectionId}: ${err.message}`);
    return topics;
  }
}

module.exports = {
  applyHumanReadableTopicLabels
};
