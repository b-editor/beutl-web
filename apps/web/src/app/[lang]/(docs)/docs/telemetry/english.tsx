const headingClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";
const linkClass = "underline underline-offset-4 hover:text-primary";

export function EnglishTelemetryPage() {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        Telemetry Policy
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Last revised: September 6, 2026
      </p>
      <p className="leading-7 not-first:mt-6">
        This document applies to the Beutl desktop application. To improve
        Beutl&apos;s quality, we may collect usage data that is not intended to
        identify you directly (collectively, &quot;Telemetry Data&quot;).
      </p>

      <h2 className={headingClass}>1. Data we collect</h2>
      <p className="leading-7 not-first:mt-6">
        Telemetry Data primarily includes:
      </p>
      <ul className={listClass}>
        <li>Logs relating to application errors and failures</li>
        <li>Processing times, response times, and other performance data</li>
        <li>Feature usage and application operating status</li>
        <li>
          Technical information such as application, operating system, and
          runtime versions
        </li>
      </ul>

      <h2 className={headingClass}>2. Purposes of use</h2>
      <p className="leading-7 not-first:mt-6">
        We use Telemetry Data to detect and investigate defects, improve
        performance and stability, monitor security issues, compile usage
        statistics, and improve features.
      </p>

      <h2 className={headingClass}>
        3. Recipient, storage location, and retention
      </h2>
      <p className="leading-7 not-first:mt-6">
        Telemetry Data is sent to and stored in Grafana Cloud, which is operated
        by Raintank, Inc. under the Grafana Labs name. Grafana Cloud may process
        the data as logs, metrics, traces, or other telemetry signals.
      </p>
      <p className="leading-7 not-first:mt-6">
        The data may be processed in the region of the Grafana Cloud stack
        selected by the operator and by Grafana Labs subprocessors. It is kept
        for the retention period configured by the operator in Grafana Cloud
        and for any additional period reasonably necessary to investigate an
        incident.
      </p>
      <p className="leading-7 not-first:mt-6">
        For details about how Grafana Labs handles data, see the
        {" "}
        <a
          className={linkClass}
          href="https://grafana.com/legal/privacy-policy/"
          target="_blank"
          rel="noreferrer"
        >
          Grafana Labs Privacy Policy
        </a>
        .
      </p>

      <h2 className={headingClass}>4. Stopping collection</h2>
      <p className="leading-7 not-first:mt-6">
        You can stop sending Telemetry Data from Settings &gt; Information &gt;
        Telemetry in Beutl. Data sent before you disable telemetry may remain
        until the configured retention period expires.
      </p>
    </article>
  );
}
