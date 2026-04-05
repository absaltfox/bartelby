'use strict';

const { listProviders, providerNeedsApiKey } = require('./llm');
const { settings, settingsAsync, userApiKeys, userApiKeysAsync } = require('../database/db');

function prettifyProviderName(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'claude') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'lmstudio') return 'LM Studio';
  if (provider === 'ollama') return 'Ollama';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function canUseSystemProvider(user, provider) {
  const hasConfiguredSystemProvider = settings.hasSystemKeyForProvider(provider);
  if (!hasConfiguredSystemProvider) return false;
  if (!providerNeedsApiKey(provider)) return true;
  if (!user) return false;
  return user.role === 'admin' || !!user.can_use_system_api_keys;
}

async function canUseSystemProviderAsync(user, provider) {
  const hasConfiguredSystemProvider = await settingsAsync.hasSystemKeyForProvider(provider);
  if (!hasConfiguredSystemProvider) return false;
  if (!providerNeedsApiKey(provider)) return true;
  if (!user) return false;
  return user.role === 'admin' || !!user.can_use_system_api_keys;
}

function buildProviderAccessOptions(user) {
  const userKeyMap = user ? userApiKeys.getProviderOptionsForUser(user.id) : {};
  const options = [];

  for (const provider of listProviders()) {
    const sources = [];
    const hasSystemAccess = canUseSystemProvider(user, provider);

    if (hasSystemAccess) {
      sources.push({
        type: 'system',
        value: 'system',
        label: providerNeedsApiKey(provider) ? 'System key' : 'System provider'
      });
    }

    const userKeys = userKeyMap[provider] || [];
    userKeys.forEach(key => {
      sources.push({
        type: 'user',
        value: `user:${key.id}`,
        keyId: key.id,
        label: key.label
      });
    });

    if (sources.length > 0) {
      options.push({
        provider,
        label: prettifyProviderName(provider),
        requiresApiKey: providerNeedsApiKey(provider),
        sources
      });
    }
  }

  return options;
}

async function buildProviderAccessOptionsAsync(user) {
  const userKeyMap = user ? await userApiKeysAsync.getProviderOptionsForUser(user.id) : {};
  const options = [];

  for (const provider of listProviders()) {
    const sources = [];
    const hasSystemAccess = await canUseSystemProviderAsync(user, provider);

    if (hasSystemAccess) {
      sources.push({
        type: 'system',
        value: 'system',
        label: providerNeedsApiKey(provider) ? 'System key' : 'System provider'
      });
    }

    const userKeys = userKeyMap[provider] || [];
    userKeys.forEach(key => {
      sources.push({
        type: 'user',
        value: `user:${key.id}`,
        keyId: key.id,
        label: key.label
      });
    });

    if (sources.length > 0) {
      options.push({
        provider,
        label: prettifyProviderName(provider),
        requiresApiKey: providerNeedsApiKey(provider),
        sources
      });
    }
  }

  return options;
}

function resolveProviderSelection(user, provider, sourceValue) {
  const options = buildProviderAccessOptions(user);
  const entry = options.find(option => option.provider === provider);
  if (!entry) {
    throw new Error('That AI provider is not available for your account.');
  }

  const source = entry.sources.find(item => item.value === sourceValue)
    || entry.sources[0];

  if (!source) {
    throw new Error('That AI credential source is not available for your account.');
  }

  if (source.type === 'system') {
    return {
      provider,
      providerKeyScope: 'system',
      userApiKeyId: null,
      runtimeConfig: {}
    };
  }

  const key = userApiKeys.getResolvedForUser(source.keyId, user.id);
  if (!key) {
    throw new Error('That personal API key is not available for your account.');
  }

  const rc = { apiKey: key.api_key };
  if (key.model) rc.model = key.model;
  if (key.vision_model) rc.visionModel = key.vision_model;
  if (key.utility_model) rc.utilityModel = key.utility_model;

  return {
    provider,
    providerKeyScope: 'user',
    userApiKeyId: key.id,
    runtimeConfig: rc
  };
}

async function resolveProviderSelectionAsync(user, provider, sourceValue) {
  const options = await buildProviderAccessOptionsAsync(user);
  const entry = options.find(option => option.provider === provider);
  if (!entry) {
    throw new Error('That AI provider is not available for your account.');
  }

  const source = entry.sources.find(item => item.value === sourceValue)
    || entry.sources[0];

  if (!source) {
    throw new Error('That AI credential source is not available for your account.');
  }

  if (source.type === 'system') {
    return {
      provider,
      providerKeyScope: 'system',
      userApiKeyId: null,
      runtimeConfig: {}
    };
  }

  const key = await userApiKeysAsync.getResolvedForUser(source.keyId, user.id);
  if (!key) {
    throw new Error('That personal API key is not available for your account.');
  }

  const rc = { apiKey: key.api_key };
  if (key.model) rc.model = key.model;
  if (key.vision_model) rc.visionModel = key.vision_model;
  if (key.utility_model) rc.utilityModel = key.utility_model;

  return {
    provider,
    providerKeyScope: 'user',
    userApiKeyId: key.id,
    runtimeConfig: rc
  };
}

module.exports = {
  buildProviderAccessOptions,
  buildProviderAccessOptionsAsync,
  canUseSystemProvider,
  canUseSystemProviderAsync,
  prettifyProviderName,
  resolveProviderSelection,
  resolveProviderSelectionAsync
};
