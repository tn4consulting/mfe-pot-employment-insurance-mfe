import { fetchRuntimeConfig } from '@tn4consulting/shared-runtime-config';

/**
 * Replaces environment.ts/environment.prod.ts + fileReplacements -- see
 * CLAUDE.md's Hosting section. Under plain `nx serve` these dev defaults
 * apply directly; in a container, the entrypoint script injects real values
 * via window.__mfePotEnv from the Helm chart's ConfigMap.
 *
 * Fetched from this app's own origin (not read off window.__mfePotEnv)
 * because this app is loaded as a Native Federation remote inside the
 * shell as often as it's loaded standalone -- when federated, this app's
 * own index.html/env.js never loads (the shell's already-running page
 * just imports this app's JS module into the same window), so
 * window.__mfePotEnv only ever carries the shell's own values. Fetching
 * this app's own env.js directly from its own origin works in both cases.
 */
const devDefaults = {
  employmentInsuranceBffBaseUrl: 'http://localhost:3002',
  strapiBaseUrl: 'http://localhost:1337',
};

/**
 * The Helm chart deliberately sets `employmentInsuranceBffBaseUrl` to `""`
 * (same-origin -- see the chart's own comment), and the dev default is
 * already a full absolute URL (`http://localhost:3002`). A same-origin
 * *relative* value is only safe for `fetchRuntimeConfig` itself (which
 * already anchors its own `env.js` fetch to `ownOriginUrl`, per this
 * file's top comment) -- `HttpEmploymentInsuranceApiClient` later does a
 * plain `fetch(`${baseUrl}/api/applications`)`, and a relative fetch
 * always resolves against the *document's* origin, not this remote's own.
 * Confirmed the hard way: composed into msca-shell at a different origin,
 * that request silently hit the shell's own nginx (405) instead of this
 * app's own `/api` Ingress path rule, throwing "temporarily unavailable"
 * on every submit -- worked fine only when this app happened to be
 * accessed standalone, at its own origin. Same class of problem
 * `asset-base-url.ts` already solves for i18n/content-fallback fetches;
 * anchoring a same-origin-relative value to this remote's own origin here
 * is the same fix applied to the BFF base URL specifically.
 */
function resolveBffBaseUrl(value: string, ownOriginUrl: string): string {
  if (/^https?:\/\//.test(value)) {
    return value;
  }
  return new URL(ownOriginUrl).origin + value;
}

export async function loadRuntimeConfig(ownOriginUrl: string) {
  const config = await fetchRuntimeConfig(ownOriginUrl, devDefaults);
  return { ...config, employmentInsuranceBffBaseUrl: resolveBffBaseUrl(config.employmentInsuranceBffBaseUrl, ownOriginUrl) };
}
