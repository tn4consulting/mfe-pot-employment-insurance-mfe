import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { getStoredSession } from '@tn4consulting/shared-auth/core';
import { useLocale } from '@tn4consulting/shared-i18n';
import type { ContentClient } from '@tn4consulting/shared-content-client';
import { fillTemplate } from '@tn4consulting/shared-content-client';
import { withRemoteParent } from '@tn4consulting/shared-observability';
import type { EiReportingStatus, EiReportingStatusLabel, EmploymentInsuranceApiClient } from 'employment-insurance-data-access';
import { HttpEmploymentInsuranceApiClient } from 'employment-insurance-data-access';
import { assetBaseUrl } from './asset-base-url';
import { loadRuntimeConfig } from '../runtime-config';
import { REPORTING_STATUS_CONTENT_KEYS, createContentClient } from './content-client';
import { usePageContents } from './use-page-contents';

const STATUS_TONE: Record<EiReportingStatusLabel, 'warning' | 'danger' | undefined> = {
  not_yet_due: undefined,
  due_soon: 'warning',
  overdue: 'danger',
};

const STATUS_CONTENT_KEY: Record<EiReportingStatusLabel, (typeof REPORTING_STATUS_CONTENT_KEYS)[number]> = {
  not_yet_due: 'employment-insurance.reporting-status.notYetDue',
  due_soon: 'employment-insurance.reporting-status.dueSoon',
  overdue: 'employment-insurance.reporting-status.overdue',
};

export interface ReportingStatusProps {
  /**
   * Fires once, after this component's own fetch resolves, with whatever
   * it fetched (`null` means "no active claim", a legitimate resolved
   * state, not an error). Lets a consumer observe the real reporting
   * status without re-implementing the fetch. Optional and additive --
   * every existing call site (this app's own `App.tsx`, and any federated
   * consumer that predates this prop) still works with zero props. Added
   * for `mfe-pot-life-events-mfe`'s guided-journey checklist,
   * which needs to know whether the citizen has applied for EI and
   * whether their reporting is current, to mark those checklist items
   * complete -- deliberately generic (just "here's what loaded"), not
   * anything loss-of-job-specific; that framing lives entirely in the
   * consumer.
   */
  onStatusLoaded?: (status: EiReportingStatus | null) => void;
  /**
   * A serialized W3C traceparent from the composing page's own root span
   * (see @tn4consulting/shared-observability's startPageSpan), so this
   * widget's own fetch to employment-insurance-bff joins that trace
   * instead of starting a disconnected one -- see dashboard-mfe's
   * Overview.tsx. Optional and harmless when absent -- withRemoteParent
   * no-ops on undefined, same additive shape as onStatusLoaded above.
   */
  parentTraceparent?: string;
}

/**
 * Rendered directly by this app's own App.tsx, and also still exposed as
 * `./EiReportingStatusWidget` for a federated consumer to embed (dashboard
 * used to; see App.tsx's own comment on why it no longer does). Fully
 * self-configuring (fetches its own runtime config, builds its own API
 * client and content client) since there's no host guaranteed to supply
 * one -- same "every remote does its own setup" principle as every other
 * converted widget in this family, and why it needed no changes to also
 * render inline here. `reportingStatus.nextReportDue` takes a
 * pre-formatted, locale-aware date string (computed here via
 * Intl.DateTimeFormat, not raw ISO) plus a raw day count, filled into the
 * CMS template via `fillTemplate`.
 */
export function ReportingStatus({ onStatusLoaded, parentTraceparent }: ReportingStatusProps = {}) {
  const locale = useLocale();
  const [apiClient, setApiClient] = useState<EmploymentInsuranceApiClient | null>(null);
  const [contentClient, setContentClient] = useState<ContentClient | null>(null);
  const [reportingStatus, setReportingStatus] = useState<EiReportingStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const content = usePageContents(contentClient, REPORTING_STATUS_CONTENT_KEYS, locale);
  // A ref, not a fetch-effect dependency -- see JobApplicationsList's
  // identical pattern/rationale in mfe-pot-job-bank-mfe for why.
  const onStatusLoadedRef = useRef(onStatusLoaded);
  onStatusLoadedRef.current = onStatusLoaded;

  function label(key: (typeof REPORTING_STATUS_CONTENT_KEYS)[number]): string {
    return content[key]?.title ?? key;
  }

  useEffect(() => {
    let cancelled = false;
    loadRuntimeConfig(assetBaseUrl).then((runtimeConfig) => {
      if (!cancelled) {
        setApiClient(new HttpEmploymentInsuranceApiClient(runtimeConfig.employmentInsuranceBffBaseUrl));
        setContentClient(createContentClient(runtimeConfig.strapiBaseUrl, assetBaseUrl));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!apiClient) {
      return;
    }
    const session = getStoredSession();
    if (!session) {
      return;
    }
    let cancelled = false;
    withRemoteParent(parentTraceparent, () => apiClient.getReportingStatus(session.sub))
      .then((status) => {
        if (!cancelled) {
          setReportingStatus(status);
          setLoaded(true);
          onStatusLoadedRef.current?.(status);
        }
      })
      .catch((err) => {
        console.error('Failed to load EI reporting status', err);
        if (!cancelled) {
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, parentTraceparent]);

  const formattedNextReportDue = reportingStatus
    ? new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'long' }).format(
        new Date(reportingStatus.nextReportDue),
      )
    : null;

  return (
    <section className="reporting-status">
      <h2>{label('employment-insurance.reporting-status.heading')}</h2>
      {loadError ? (
        <p role="alert">{label('employment-insurance.reporting-status.unavailable')}</p>
      ) : loaded ? (
        reportingStatus ? (
          <scds-card
            card-title={label(STATUS_CONTENT_KEY[reportingStatus.status])}
            description={fillTemplate(label('employment-insurance.reporting-status.nextReportDue'), {
              date: formattedNextReportDue ?? '',
              days: reportingStatus.daysUntilDue,
            })}
            tone={STATUS_TONE[reportingStatus.status]}
          />
        ) : (
          <p>{label('employment-insurance.reporting-status.noClaim')}</p>
        )
      ) : null}
    </section>
  );
}
