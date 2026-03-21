const OpenAIProvider = require('./openai');

/**
 * Available LLM providers
 */
const providers = {
  openai: OpenAIProvider,
  // Add more providers here as needed:
  // deepseek: DeepSeekProvider,
  // anthropic: AnthropicProvider,
};

/**
 * Create an LLM provider instance
 * @param {string} providerName - Name of the provider ('openai', 'deepseek', etc.)
 * @param {object} config - Provider configuration
 * @returns {LLMProvider}
 */
function createProvider(providerName = 'openai', config = {}) {
  const Provider = providers[providerName.toLowerCase()];

  if (!Provider) {
    const available = Object.keys(providers).join(', ');
    throw new Error(`Unknown LLM provider: ${providerName}. Available: ${available}`);
  }

  return new Provider(config);
}

/**
 * List available providers
 * @returns {string[]}
 */
function listProviders() {
  return Object.keys(providers);
}

module.exports = {
  createProvider,
  listProviders,
  providers,
  // Export individual providers for direct use
  OpenAIProvider,
};
