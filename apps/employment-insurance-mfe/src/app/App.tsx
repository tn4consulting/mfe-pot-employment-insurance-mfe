// See below -- required for the classic JSX transform this app's
// tsconfig uses (react/jsx-runtime can't resolve once this bundle treats
// react as a federation-shared external).
import * as React from 'react';
import { useEffect, useState } from 'react';
import { CLAIM_EI, getStoredSession, hasClaim, onSessionChange } from '@tn4consulting/shared-auth/core';
import type { ContentClient, PageContent } from '@tn4consulting/shared-content-client';
import { useLocale, useTranslations } from '@tn4consulting/shared-i18n';
import type { EmploymentInsuranceApiClient } from 'employment-insurance-data-access';
import { HttpEmploymentInsuranceApiClient } from 'employment-insurance-data-access';
import { createContentClient, INTRO_CONTENT_KEY } from './content-client';
import { loadRuntimeConfig } from '../runtime-config';
import { assetBaseUrl } from './asset-base-url';
import { Applications } from './Applications';
import { Claims } from './Claims';
import { Reporting } from './Reporting';
import { ReportingStatus } from './ReportingStatus';
import './register-scds';

interface RemoteConfig {
  apiClient: EmploymentInsuranceApiClient;
  contentClient: ContentClient;
}

/**
 * Does its own setup entirely -- no host-provided REMOTE_PROVIDERS
 * equivalent (see RemoteRouteHost in shared-federation-runtime for why).
 * Auth/claim check lives here, not in the feature components -- defense
 * in depth, this app validates its own claim independently.
 *
 * `ReportingStatus.tsx` renders here too, not just as the federated
 * `./EiReportingStatusWidget` dashboard used to embed -- dashboard's own
 * overview dropped that embed (docs/msca-screenshots/dashboard.png has no
 * EI-reporting-status tile on the dashboard page), so this app's own page
 * is now the one place a citizen actually sees it. The federation expose
 * itself is untouched (still real, still buildable) in case a future
 * consumer wants it; ReportingStatus is fully self-configuring either way
 * (see its own comment), so rendering it here needed no props threaded in.
 */
export function App() {
  const [hasAccess, setHasAccess] = useState(() => hasClaim(getStoredSession(), CLAIM_EI));
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [intro, setIntro] = useState<PageContent | null>(null);
  const [introLoadError, setIntroLoadError] = useState(false);
  const locale = useLocale();
  const { t } = useTranslations(assetBaseUrl, locale);

  useEffect(() => onSessionChange((session) => setHasAccess(hasClaim(session, CLAIM_EI))), []);

  useEffect(() => {
    let cancelled = false;
    loadRuntimeConfig(assetBaseUrl).then((runtimeConfig) => {
      if (cancelled) {
        return;
      }
      setConfig({
        apiClient: new HttpEmploymentInsuranceApiClient(runtimeConfig.employmentInsuranceBffBaseUrl),
        contentClient: createContentClient(runtimeConfig.strapiBaseUrl, assetBaseUrl),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // CMS content (unlike the i18n chrome text above) isn't reactive by
  // default, so this app explicitly re-fetches whenever the cross-remote
  // active locale changes -- same pattern as every other converted app.
  useEffect(() => {
    if (!config) {
      return;
    }
    let cancelled = false;
    config.contentClient
      .getPageContent(INTRO_CONTENT_KEY, locale === 'fr' ? 'fr' : 'en')
      .then((content) => {
        if (!cancelled) {
          setIntro(content);
          setIntroLoadError(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load employment-insurance intro content', err);
        if (!cancelled) {
          setIntroLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config, locale]);

  if (!hasAccess) {
    return <p role="alert">{t('auth.signInRequired')}</p>;
  }

  if (!config) {
    return null;
  }

  return (
    <>
      {intro ? (
        <section>
          <h1>{intro.title}</h1>
          <p>{intro.body}</p>
        </section>
      ) : introLoadError ? (
        <p role="alert">{t('errors.contentUnavailable')}</p>
      ) : null}
      <Applications apiClient={config.apiClient} contentClient={config.contentClient} locale={locale} />
      <Claims apiClient={config.apiClient} contentClient={config.contentClient} locale={locale} />
      <Reporting apiClient={config.apiClient} contentClient={config.contentClient} locale={locale} />
      <ReportingStatus />
    </>
  );
}
