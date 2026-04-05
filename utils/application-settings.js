'use strict';

const DEFAULT_APP_NAME = 'Bartelby';

const DEFAULT_APP_LOGO_SVG = `
<svg viewBox="0 0 22 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M19 1 C 22 5, 21 15, 14 24 C 11 28, 8 33, 6 39 C 4 35, 3 33, 1 35 C -1 31, 2 27, 6 25 C 3 18, 3 9, 8 4 C 12 0, 18 -1, 19 1 Z" fill="#f0d8b4"/>
  <path d="M19 1 C 21 6, 18 16, 12 24" stroke="#e8c890" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
  <path d="M16 7 L12 11" stroke="#d4a870" stroke-width="0.7" stroke-linecap="round"/>
  <path d="M13 13 L9 17" stroke="#d4a870" stroke-width="0.7" stroke-linecap="round"/>
  <path d="M10 19 L7 22" stroke="#d4a870" stroke-width="0.7" stroke-linecap="round"/>
  <path d="M19 1 L6 39" stroke="#c08840" stroke-width="1.1" stroke-linecap="round"/>
  <path d="M6 39 L4 43 M6 39 L8 42" stroke="#c08840" stroke-width="0.9" stroke-linecap="round"/>
</svg>`.trim();

const DEFAULT_APP_FAVICON_SVG = `
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="#2a1e14"/>
  <path d="M44 8c3 4 2 14-5 23-3 4-6 9-8 17-2-3-3-4-5-2-2-4 1-8 5-10-3-7-3-15 1-20 4-4 10-5 12-3Z" fill="#f0d8b4"/>
  <path d="M44 8 31 48" stroke="#c08840" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M42 14 36 20M38 24 33 29M34 33 30 37" stroke="#d4a870" stroke-width="1.4" stroke-linecap="round"/>
</svg>`.trim();

const DEFAULT_TERMS_OF_SERVICE = `This site is provided on an as-is basis.

By using the site, you agree that you are using it at your own risk.

The site owner does not accept liability for any loss, damage, claim, data issue, transcription error, workflow problem, service interruption, or other consequence that may result from using the app.

Any data you enter, upload, store, export, or act on through the site is your responsibility. You should make your own decisions about what to enter, how to use the results, and whether the output is appropriate for your needs.

If you do not accept these terms, you should not use the site.`;

const DEFAULT_PRIVACY_POLICY = `This application stores the information you enter in order to provide document management, transcription, and account features.

That information may include uploaded document images, transcripts, annotations, collection metadata, account details, and audit history.

Only authorized users should be given access to the system. Administrators are responsible for configuring access appropriately and for deciding what content is suitable to store in the application.

If you operate this application for others, you should describe your own retention, backup, and disclosure practices here.`;

const DEFAULT_DATA_SECURITY_INFORMATION = `Access to this application is controlled through authenticated user accounts and role-based permissions.

Sensitive credentials such as supported provider API keys can be stored through the settings interface. When encryption is configured, those stored secrets are encrypted at rest.

Administrators are responsible for securing the hosting environment, database backups, network access, and any external storage or AI providers connected to the application.

No software system can guarantee absolute security. You should review your deployment configuration regularly and use security controls appropriate to the sensitivity of your data.`;

function withFallback(value, fallback) {
  return (typeof value === 'string' && value.trim()) ? value : fallback;
}

function sanitizeSvgMarkup(markup, fallback) {
  const candidate = withFallback(markup, fallback);
  return String(candidate || '')
    // Remove script blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove foreignObject (allows HTML injection)
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    // Remove style blocks (CSS injection vector)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove use elements (can reference external resources)
    .replace(/<use[\s\S]*?\/>/gi, '')
    .replace(/<use[\s\S]*?<\/use>/gi, '')
    // Strip inline event handlers (both quoted and unquoted)
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // Strip javascript: hrefs
    .replace(/\s(?:href|xlink:href)\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*javascript:[^\s>]+/gi, '')
    // Strip inline style attributes (CSS injection)
    .replace(/\sstyle\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .trim();
}

function svgToDataUri(svgMarkup) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(String(svgMarkup || ''))}`;
}

function resolveApplicationSettings(cfg = {}) {
  const appLogoSvg = sanitizeSvgMarkup(cfg.app_logo_svg, DEFAULT_APP_LOGO_SVG);
  const appFaviconSvg = sanitizeSvgMarkup(cfg.app_favicon_svg, DEFAULT_APP_FAVICON_SVG);
  return {
    appName: withFallback(cfg.app_name, DEFAULT_APP_NAME),
    appLogoSvg,
    appLogoDataUri: svgToDataUri(appLogoSvg),
    appFaviconSvg,
    appFaviconDataUri: svgToDataUri(appFaviconSvg),
    deploymentNotice: typeof cfg.deployment_notice === 'string' ? cfg.deployment_notice.trim() : '',
    termsOfService: withFallback(cfg.terms_of_service, DEFAULT_TERMS_OF_SERVICE),
    privacyPolicy: withFallback(cfg.privacy_policy, DEFAULT_PRIVACY_POLICY),
    dataSecurityInfo: withFallback(cfg.data_security_info, DEFAULT_DATA_SECURITY_INFORMATION)
  };
}

module.exports = {
  DEFAULT_APP_NAME,
  DEFAULT_APP_LOGO_SVG,
  DEFAULT_APP_FAVICON_SVG,
  DEFAULT_TERMS_OF_SERVICE,
  DEFAULT_PRIVACY_POLICY,
  DEFAULT_DATA_SECURITY_INFORMATION,
  sanitizeSvgMarkup,
  svgToDataUri,
  resolveApplicationSettings
};
