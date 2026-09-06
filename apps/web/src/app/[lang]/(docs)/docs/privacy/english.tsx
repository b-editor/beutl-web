import Link from "next/link";

const sectionClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const subSectionClass =
  "mt-6 scroll-m-20 text-xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";
const orderedListClass = "my-6 ml-6 list-decimal [&>li]:mt-2";
const linkClass = "underline underline-offset-4 hover:text-primary";

export function EnglishPrivacyPage({ lang }: { lang: string }) {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        Privacy Policy
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Established: October 12, 2024; last revised: September 6, 2026
      </p>
      <p className="leading-7 not-first:mt-6">
        The operator of Beutl (the &quot;Operator&quot;) handles information
        about Users of Beutl accounts, the Store, cloud storage, paid AI
        features, APIs, and other online services (collectively, the
        &quot;Service&quot;) as described in this Privacy Policy.
      </p>
      <p className="leading-7 not-first:mt-6">
        This Policy applies to beutl.beditor.net, APIs provided under that
        domain, and the rest of the Service. External sites and packages
        independently supplied by third parties may be governed by their own
        policies. For usage data optionally sent by the Beutl desktop
        application, also review the
        {" "}
        <Link className={linkClass} href={`/${lang}/docs/telemetry`}>
          Telemetry Policy
        </Link>
        .
      </p>

      <h2 className={sectionClass}>1. Controller</h2>
      <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 leading-7">
        <dt className="font-semibold">Name</dt>
        <dd>Disclosed without delay upon request.</dd>
        <dt className="font-semibold">Address</dt>
        <dd>Disclosed without delay upon a verified request.</dd>
        <dt className="font-semibold">Contact</dt>
        <dd>contact@beditor.net</dd>
      </dl>

      <h2 className={sectionClass}>2. Information we collect</h2>

      <h3 className={subSectionClass}>
        2.1 Account and authentication information
      </h3>
      <ul className={listClass}>
        <li>Name or display name, email address, profile image, and User ID</li>
        <li>
          Profile biography, public username, and registered social links
        </li>
        <li>
          Connected services such as Google or GitHub, external account
          identifiers, authentication tokens, and authorized scopes
        </li>
        <li>
          Passkey public key, authenticator type, backup status, creation time,
          and last-used time
        </li>
        <li>
          Tokens and expiration times needed for sessions, desktop application
          authentication, and identity verification
        </li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        The Service does not currently offer password authentication, so the
        Operator does not collect a password for your Beutl account. The
        Operator also does not receive your Google or GitHub password.
      </p>

      <h3 className={subSectionClass}>
        2.2 Profiles, storage, and published content
      </h3>
      <ul className={listClass}>
        <li>
          Stored or published file contents, file name, type, size, hash,
          visibility, and creation and update times
        </li>
        <li>
          Package name, description, website, tags, price, currency, images,
          releases, supported versions, and publication status
        </li>
        <li>
          Packages acquired from the Store, additions to and removals from the
          library, and information required for downloads
        </li>
        <li>
          Upload progress, identifiers needed to resume or safely delete an
          upload, and processing records
        </li>
      </ul>

      <h3 className={subSectionClass}>
        2.3 AI input, output, and usage history
      </h3>
      <ul className={listClass}>
        <li>
          Prompts, editing instructions, glossaries, subtitles, languages,
          styles, and other settings
        </li>
        <li>
          Reference images, images to edit, first and last video frames, and
          audio submitted for transcription
        </li>
        <li>
          Generated images and videos, transcriptions, translations, and other
          AI output
        </li>
        <li>
          Selected model, operation type, status, errors, timestamps, allowance
          consumed, retry data, and identifiers used to prevent duplicate
          charges
        </li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        Images, audio, and subtitles may contain faces, voices, names, or other
        personal information relating to you or another person. Submit only
        information for which you have all required rights and individual
        consents.
      </p>

      <h3 className={subSectionClass}>
        2.4 Purchases, billing, and usage allowances
      </h3>
      <ul className={listClass}>
        <li>
          Stripe customer, checkout, payment, invoice, subscription, refund,
          and dispute identifiers and statuses
        </li>
        <li>
          Purchased product, amount, currency, billing period, purchase time,
          entitlement, and payment history
        </li>
        <li>
          Monthly AI usage, additional credits, adjustments following refunds
          or reversals, and transaction history
        </li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        Card numbers, security codes, and other complete card details are
        entered directly into Stripe and are not stored by the Operator.
      </p>

      <h3 className={subSectionClass}>2.5 Inquiries and feedback</h3>
      <p className="leading-7 not-first:mt-6">
        We collect your name, email address, inquiry category and message,
        response status, and communications with the Operator.
      </p>

      <h3 className={subSectionClass}>
        2.6 Technical information and usage records
      </h3>
      <ul className={listClass}>
        <li>
          IP address, source port, User-Agent, browser, operating system, device
          type, and approximate country or region
        </li>
        <li>
          Access time, requested destination, activity, referrer, response
          status, error information, and security audit logs
        </li>
        <li>
          Cookies, session identifiers, and settings and recovery information
          stored in the browser
        </li>
      </ul>

      <h3 className={subSectionClass}>
        2.7 Information received from external services
      </h3>
      <p className="leading-7 not-first:mt-6">
        When you choose to use an integration, we receive your name, email
        address, profile image, external account identifier, and other
        authentication information from Google or GitHub; payment and contract
        status from Stripe; and results and usage information from AI providers.
        The exact information depends on your settings, each service&apos;s
        specifications, and the authorization screen.
      </p>

      <h2 className={sectionClass}>3. Purposes of use</h2>
      <p className="leading-7 not-first:mt-6">
        The Operator uses collected information to:
      </p>
      <ul className={listClass}>
        <li>Verify identity and manage authentication, accounts, and profiles</li>
        <li>
          Store, retrieve, publish, distribute, meter, and safely delete files
        </li>
        <li>
          Publish, review, search, acquire, purchase, manage, and redistribute
          packages
        </li>
        <li>
          Run AI operations, store results, display history, calculate usage,
          prevent duplicate execution, and recover from failures
        </li>
        <li>
          Process payments, invoices, subscriptions, refunds, reversals, fraud
          prevention, and accounting
        </li>
        <li>Answer inquiries, provide support, and send important notices</li>
        <li>
          Investigate failures, monitor security, prevent unauthorized access,
          maintain audit records, and respond to rights infringements
        </li>
        <li>Improve the Service&apos;s quality, performance, usability, and features</li>
        <li>
          Compile and analyze usage, cost, and operation statistics in a form
          that does not identify an individual
        </li>
        <li>
          Perform these Terms and other conditions, resolve disputes, and meet
          legal obligations
        </li>
      </ul>

      <h2 className={sectionClass}>4. Information made public</h2>
      <p className="leading-7 not-first:mt-6">
        If you choose to publish them, your public username, display name,
        biography, social links, profile image, published packages,
        descriptions, prices, screenshots, and release files become available
        to the public on the internet. Copies may remain in search engines or
        third-party storage after you stop publishing the information. Do not
        include confidential information or personal information that must not
        be made public.
      </p>

      <h2 className={sectionClass}>5. Information handled by AI features</h2>
      <ol className={orderedListClass}>
        <li>
          AI input is sent to OpenRouter, Inc. for processing and is then sent
          to the business that operates the selected model. The model publisher
          and the provider that actually runs the model may differ.
        </li>
        <li>
          Retention, training use, and safety review of input and output by
          OpenRouter and each AI provider vary according to the selected model,
          processing route, and provider policies. The Service does not
          guarantee zero data retention or exclusion from training for every AI
          operation.
        </li>
        <li>
          The Operator stores results, job history, and information needed for
          billing and recovery. Unless you separately save them to storage,
          source images and audio are ordinarily processed temporarily for the
          AI operation and are not stored as Beutl job-history files. Retention
          by external AI providers remains subject to their terms.
        </li>
        <li>
          Do not submit confidential information, authentication information,
          sensitive personal information, medical or financial information, or
          another person&apos;s personal information unless you have lawful
          authority and a genuine need to transmit it.
        </li>
      </ol>
      <p className="leading-7 not-first:mt-6">
        For current information about OpenRouter&apos;s practices, review the
        {" "}
        <a
          className={linkClass}
          href="https://openrouter.ai/privacy"
          target="_blank"
          rel="noreferrer"
        >
          OpenRouter Privacy Policy
        </a>
        {" "}
        and
        {" "}
        <a
          className={linkClass}
          href="https://openrouter.ai/docs/guides/privacy/provider-logging"
          target="_blank"
          rel="noreferrer"
        >
          Provider Logging
        </a>
        .
      </p>

      <h2 className={sectionClass}>6. Cookies and browser storage</h2>
      <ol className={orderedListClass}>
        <li>
          The Service uses necessary cookies to maintain sign-in state, protect
          security, and remember settings such as whether the sidebar is open.
          Disabling cookies may prevent sign-in or other features from working.
        </li>
        <li>
          The Service stores AI prompt templates, temporary handoff data from
          transcription to translation, recovery identifiers used to avoid
          duplicate operations, upload-completion recovery data, and similar
          information in local storage or session storage. This information
          ordinarily remains on your device, and only the portion required for
          a feature is sent to the Service when you use that feature.
        </li>
        <li>
          You can delete cookies and browser storage in your browser settings.
          Doing so may prevent automatic recovery of an incomplete upload or AI
          operation.
        </li>
        <li>
          The Service&apos;s web application currently does not embed cookies,
          advertising tags, or analytics SDKs for advertising or cross-site
          behavioral tracking.
        </li>
      </ol>

      <h2 className={sectionClass}>
        7. Disclosures to and processing by external providers
      </h2>
      <p className="leading-7 not-first:mt-6">
        To provide the Service, the Operator engages the following providers to
        process information or discloses information at your direction. A
        provider&apos;s own policy may also apply when it independently collects
        information.
      </p>
      <div className="my-6 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border px-3 py-2 text-left">Provider or service</th>
              <th className="border px-3 py-2 text-left">Purpose</th>
              <th className="border px-3 py-2 text-left">
                Main information processed
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://www.cloudflare.com/privacypolicy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Cloudflare, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">
                Delivery, server execution, caching, file storage, security,
                and operational monitoring
              </td>
              <td className="border px-3 py-2">
                IP address, HTTP communications, technical logs, files, and
                Service data
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://www.cockroachlabs.com/privacy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Cockroach Labs, Inc. (CockroachDB)
                </a>
                <br />
                Data storage region: Singapore
              </td>
              <td className="border px-3 py-2">
                Storage of accounts, history, entitlements, and processing
                state
              </td>
              <td className="border px-3 py-2">
                Information recorded in the Service database
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://stripe.com/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Stripe, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">
                Payments, recurring purchases, invoices, refunds, and fraud
                prevention
              </td>
              <td className="border px-3 py-2">
                Email address, customer and transaction identifiers, purchase
                details, amounts, card details, and billing information
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://policies.google.com/privacy?hl=en"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google LLC
                </a>
                {" / "}
                <a
                  className={linkClass}
                  href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">
                Authentication through an external account and display of
                connected information
              </td>
              <td className="border px-3 py-2">
                External account identifier, name, email address, profile
                image, authentication tokens, and authorized scopes
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://resend.com/legal/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Plus Five Five, Inc. (Resend)
                </a>
              </td>
              <td className="border px-3 py-2">
                Sending sign-in links, identity-verification messages, and
                Service notices
              </td>
              <td className="border px-3 py-2">
                Email address, message body, and delivery information
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://openrouter.ai/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenRouter, Inc.
                </a>
                {" and the provider of the selected AI model"}
              </td>
              <td className="border px-3 py-2">
                AI processing, model routing, returning results, and usage
                management
              </td>
              <td className="border px-3 py-2">
                AI input and output, model, processing identifiers, and
                technical usage information
              </td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://ipinfo.io/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                >
                  IPinfo, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">
                Estimating currency by country when the delivery platform does
                not supply country information
              </td>
              <td className="border px-3 py-2">IP address</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://grafana.com/legal/privacy-policy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Raintank, Inc. (Grafana Labs / Grafana Cloud)
                </a>
              </td>
              <td className="border px-3 py-2">
                Optional desktop application telemetry
              </td>
              <td className="border px-3 py-2">
                Error logs, performance and usage data, and other telemetry
                information described in the Telemetry Policy
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="leading-7 not-first:mt-6">
        When a Google or GitHub profile image is displayed, the image host may
        receive your IP address, User-Agent, referrer information, and similar
        data. A third party may also collect information after you follow an
        external link.
      </p>
      <p className="leading-7 not-first:mt-6">
        The Operator may also disclose information with your consent; where
        required by law; where necessary to protect life, physical safety, or
        property and consent is difficult to obtain; as part of a business
        transfer; or in another circumstance permitted by the Act on the
        Protection of Personal Information or other applicable law.
      </p>

      <h2 className={sectionClass}>8. Processing outside Japan</h2>
      <p className="leading-7 not-first:mt-6">
        Information recorded in the Service database is stored in the Singapore
        region of CockroachDB. Cockroach Labs, Inc. is located in the United
        States, and it or its subprocessors may process information from outside
        Singapore for service operation or support.
      </p>
      <p className="leading-7 not-first:mt-6">
        Many of the other providers listed above are also located in the United
        States, and their servers or subprocessors may be located in Japan,
        Singapore, the United States, Europe, or other countries or regions.
        The country in which an AI operation is processed varies according to
        the selected model, OpenRouter routing, availability, and the model
        provider&apos;s subprocessors, so it cannot be identified as a single
        country in advance. Potential providers and their locations are listed
        in the
        {" "}
        <a
          className={linkClass}
          href="https://openrouter.ai/providers"
          target="_blank"
          rel="noreferrer"
        >
          OpenRouter provider directory
        </a>
        .
      </p>
      <p className="leading-7 not-first:mt-6">
        The Operator reviews public information and contractual terms of these
        providers and applies safeguards such as limiting transmitted data,
        encrypting communications, and controlling access. Contact the Operator
        if you need more information about processing countries or safeguards.
      </p>

      <h2 className={sectionClass}>9. Retention and deletion</h2>
      <ul className={listClass}>
        <li>
          Accounts, profiles, stored files, and published content are generally
          retained until you delete them or close your account.
        </li>
        <li>
          A web sign-in session is generally valid for no more than thirty days
          after its last update. It may be invalidated earlier by sign-out,
          expiration, or a security measure.
        </li>
        <li>
          Transcription and subtitle-translation result files are generally
          deleted thirty days after creation. Generated images and videos are
          generally retained until you delete the job or file or close your
          account. Job identifiers, status, input settings, and usage records
          are retained as necessary for billing, history, recovery, and fraud
          prevention.
        </li>
        <li>
          Incomplete file uploads generally become eligible for deletion after
          twenty-four hours. If a failure or uncertain response from external
          storage prevents safe deletion, recovery records may remain until
          deletion can be confirmed.
        </li>
        <li>
          Transaction, billing, refund, audit, and security records are retained
          as necessary for legal retention obligations, accounting, dispute
          resolution, fraud prevention, and protection of rights.
        </li>
        <li>
          Prompt-library data and similar browser data remains on your device
          until you remove it or clear browser storage. AI recovery information
          generally expires after thirty days.
        </li>
        <li>
          Information accepted for deletion may remain in an isolated or
          restricted state until backups are overwritten, an external provider
          completes deletion, or an in-progress payment, refund, or storage
          operation is resolved.
        </li>
      </ul>

      <h2 className={sectionClass}>10. Security measures</h2>
      <p className="leading-7 not-first:mt-6">
        The Operator applies measures including the following according to the
        nature and risk of the information. Additional details are available on
        request to the extent disclosure would not compromise security.
      </p>
      <ul className={listClass}>
        <li>
          Separation of administrator and User permissions, per-User access
          controls, and authentication
        </li>
        <li>
          Encryption in transit and appropriate hashing or secret management of
          tokens and similar information
        </li>
        <li>
          Authorization checks for private files, unpredictable storage
          identifiers, and upload-size limits
        </li>
        <li>
          Audit records for important actions, logging of anomalies and errors,
          and controls for safe retries and duplicate-processing prevention
        </li>
        <li>
          Restricting access to personal data and reviewing the data-handling
          terms of external providers
        </li>
        <li>
          Investigation, containment, recovery, and legally required regulatory
          and individual notice if a data breach occurs
        </li>
      </ul>

      <h2 className={sectionClass}>
        11. Access, correction, and deletion requests
      </h2>
      <ol className={orderedListClass}>
        <li>
          Account settings allow you to access, change, or delete profile data,
          your email address, connected accounts, passkeys, files, and AI jobs.
          You can also request account deletion from those settings.
        </li>
        <li>
          To request notice of the purpose of use; disclosure of retained
          personal data or third-party disclosure records; correction, addition,
          or deletion; cessation of use; erasure; or cessation of third-party
          disclosure, email contact@beditor.net from your registered address and
          identify the request and information concerned.
        </li>
        <li>
          The Operator will verify that the requester is the individual or an
          authorized representative through account sign-in, a reply to the
          registered email address, or another reasonable method, and will
          respond without delay as required by law. If the Operator cannot grant
          a request under applicable law, the reason will be explained.
        </li>
        <li>
          Save any files and AI results you need before deleting your account.
          They may not be recoverable afterward.
        </li>
      </ol>

      <h2 className={sectionClass}>
        12. Sale of personal information and anonymous data
      </h2>
      <p className="leading-7 not-first:mt-6">
        The Operator does not sell personal information for consideration and
        does not disclose it to third parties for advertising. Statistics that
        have been aggregated or anonymized so that they do not identify an
        individual may be used to operate or improve the Service, manage costs,
        or publish information.
      </p>

      <h2 className={sectionClass}>13. Minors</h2>
      <p className="leading-7 not-first:mt-6">
        A minor must use the Service with the consent of a parent or other legal
        representative. If you learn that personal information was provided
        without the required consent, contact the Operator. After verifying the
        circumstances, the Operator will respond as required by law.
      </p>

      <h2 className={sectionClass}>14. Changes to this Policy</h2>
      <p className="leading-7 not-first:mt-6">
        The Operator may amend this Policy in response to changes in the Service
        or applicable law. The amendment and its effective date will be
        published on this page. If an amendment materially affects Users, the
        Operator will provide reasonable advance notice through the Service, by
        email to the registered address, or by another appropriate method. An
        amendment that legally requires individual consent applies only after
        that consent is obtained through the designated process.
      </p>

      <h2 className={sectionClass}>15. Inquiries and complaints</h2>
      <p className="leading-7 not-first:mt-6">
        Send inquiries and complaints concerning personal information, this
        Policy, security measures, or an individual-rights request to:
      </p>
      <p className="leading-7 not-first:mt-6">
        Operator and privacy contact: Beutl Operator
        <br />
        Email: contact@beditor.net
      </p>
    </article>
  );
}
