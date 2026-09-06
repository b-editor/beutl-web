import Link from "next/link";

const sectionClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const subSectionClass =
  "mt-6 scroll-m-20 text-xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";
const orderedListClass = "my-6 ml-6 list-decimal [&>li]:mt-2";
const linkClass = "underline underline-offset-4 hover:text-primary";

export function EnglishTermsPage({ lang }: { lang: string }) {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        Terms of Service
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Established and last revised: September 6, 2026
      </p>
      <p className="leading-7 not-first:mt-6">
        These Terms of Service (the &quot;Terms&quot;) set out the conditions
        for using the Beutl account, Store, cloud storage, paid AI features,
        APIs, and other online services (collectively, the &quot;Service&quot;)
        provided by the person or entity that operates Beutl (&quot;we&quot;,
        &quot;us&quot;, or &quot;our&quot;).
      </p>
      <p className="leading-7 not-first:mt-6">
        Anyone who uses the Service (a &quot;User&quot;) must review and agree
        to these Terms before using it. By creating an account, signing in to
        the Service, acquiring or purchasing a product, publishing content, or
        initiating an AI operation, you agree to these Terms.
      </p>

      <h2 className={sectionClass}>1. Scope and additional terms</h2>
      <ol className={orderedListClass}>
        <li>
          These Terms apply to all aspects of our relationship with Users
          concerning the Service.
        </li>
        <li>
          Product pages, checkout screens, licenses, guidelines, notices, and
          other conditions displayed through the Service (collectively,
          &quot;Additional Terms&quot;) form part of these Terms. If Additional
          Terms conflict with these Terms, the Additional Terms take precedence
          only for the matter they specifically govern. Terms established by a
          Publisher or another third party cannot alter payment, security, or
          other aspects of the relationship between us and a User.
        </li>
        <li>
          Open-source Beutl software is governed by the licenses included with
          or displayed for that software. These Terms do not restrict rights
          granted under those open-source licenses.
        </li>
      </ol>

      <h2 className={sectionClass}>2. Eligibility</h2>
      <ol className={orderedListClass}>
        <li>
          You must have the legal capacity necessary to agree to these Terms
          and enter into a contract.
        </li>
        <li>
          A minor must obtain the prior consent of a parent or other legal
          representative before creating an account, purchasing a paid service,
          or publishing content.
        </li>
        <li>
          If you use the Service for a company or other organization, you
          represent that you have authority to bind that organization to these
          Terms.
        </li>
      </ol>

      <h2 className={sectionClass}>3. Accounts</h2>
      <ol className={orderedListClass}>
        <li>
          You must provide accurate, current information and update it when
          necessary.
        </li>
        <li>
          You are responsible for safeguarding email sign-in links, connected
          accounts, passkeys, session tokens, and all other authentication
          methods, and must not allow another person to use them.
        </li>
        <li>
          Unless an act is attributable to our intent or
          negligence, activity performed through an account is treated as
          activity of the User who owns that account. Contact us
          immediately if you become aware of unauthorized use or compromised
          authentication information.
        </li>
        <li>You may not transfer, lend, or sell your account.</li>
      </ol>

      <h2 className={sectionClass}>4. The Service</h2>
      <p className="leading-7 not-first:mt-6">
        The Service primarily includes the following features. Available
        features, capacity, processing limits, supported formats, and other
        restrictions are governed by the displays in the Service and any
        Additional Terms.
      </p>
      <ul className={listClass}>
        <li>Beutl accounts and authentication with the desktop application</li>
        <li>File storage, retrieval, and management</li>
        <li>
          Publication, acquisition, and purchase of extensions, materials,
          templates, and similar packages
        </li>
        <li>
          AI features such as image generation and editing, audio
          transcription, subtitle translation, and video generation
        </li>
        <li>Related history, billing, support, and administration features</li>
      </ul>

      <h2 className={sectionClass}>
        5. Paid services, payments, and AI allowances
      </h2>
      <ol className={orderedListClass}>
        <li>
          The price, currency, billing interval, entitlement or allowance, and
          other conditions of a paid service are displayed on the product page
          or checkout screen before you confirm a purchase. You are responsible
          for internet access charges and any other costs required to connect
          to the Service.
        </li>
        <li>
          Payments are processed through Stripe. You must also comply with the
          terms applicable to your use of Stripe.
        </li>
        <li>
          A recurring purchase renews automatically at the interval displayed
          at checkout. You may cancel it from the billing page before the next
          renewal. After cancellation, you may continue to use the applicable
          features until the end of the current access period shown on that
          page.
        </li>
        <li>
          The monthly AI allowance resets when the billing period renews, and
          unused allowance does not carry over. The balance and conditions of
          separately purchased credits are governed by the purchase and billing
          pages.
        </li>
        <li>
          Starting an AI operation reserves or consumes the allowance or
          credits indicated for that operation. If we can confirm that a failed
          operation did not run, the reserved amount is restored. If a network
          interruption or similar event makes the outcome at an external AI
          provider uncertain, the amount may remain reserved until the outcome
          is resolved in order to prevent duplicate execution.
        </li>
        <li>
          If a refund, payment reversal, or dispute occurs, we may
          revoke the corresponding product entitlement or credits. If credits
          that have already been consumed correspond to a refunded or reversed
          payment, the shortfall may be deducted from credits purchased later.
        </li>
        <li>
          Due to the nature of digital products, purchases are not returnable
          or refundable for convenience after confirmation, except where
          required by law or permitted by Additional Terms. See the
          {" "}
          <Link
            className={linkClass}
            href={`/${lang}/docs/specified-commercial-transactions-act`}
          >
            Commercial Transactions Disclosure
          </Link>
          {" "}
          for sales conditions and remedies for defective products.
        </li>
      </ol>

      <h2 className={sectionClass}>6. User Content</h2>
      <ol className={orderedListClass}>
        <li>
          Rights in text, images, audio, video, software, packages, and other
          data that a User enters, transmits, stores, or publishes through the
          Service (&quot;User Content&quot;) remain with the User or the lawful
          rightsholder.
        </li>
        <li>
          You grant us a non-exclusive license to use, reproduce,
          transform, transmit, and display User Content only as necessary to
          provide, store, convert, back up, secure, distribute, display, and
          support the Service. This license generally lasts until the relevant
          content is deleted or the account ends, but may continue for a
          reasonable period as necessary for legal compliance, dispute
          resolution, backups, and deletion processes already in progress.
        </li>
        <li>
          You represent that you hold all rights, permissions, and individual
          consents necessary for the Service to process your User Content and
          that the content does not infringe another person&apos;s copyright,
          privacy, publicity rights, or other rights.
        </li>
        <li>
          A profile, package, description, screenshot, or release set to public
          is made available to the public on the internet. Do not include
          confidential information or personal information that must not be
          disclosed.
        </li>
      </ol>

      <h2 className={sectionClass}>7. Store and published packages</h2>
      <ol className={orderedListClass}>
        <li>
          A User who publishes a package (a &quot;Publisher&quot;) must
          accurately describe its contents, supported environment, price,
          description, and license. A package must not contain malicious code
          or data materially different from its description.
        </li>
        <li>
          A Publisher grants us a non-exclusive right to use, review,
          store, reproduce, distribute, display, and promote the package as
          necessary to operate the Service and to license it to acquirers.
        </li>
        <li>
          If a separate license is displayed on a product page or included with
          a package, that license applies. If no separate license is provided,
          the Publisher grants each acquirer a non-exclusive,
          non-transferable, non-sublicensable license to:
          <ul className={listClass}>
            <li>
              Install and use the package with Beutl on devices controlled by
              the acquirer for personal or commercial productions
            </li>
            <li>
              Use, publish, distribute, or sell videos and other works created
              using the package
            </li>
            <li>
              Use a free or purchased package without a fixed end date, unless
              a specific use period was disclosed before acquisition, in which
              case the license lasts for that period
            </li>
          </ul>
        </li>
        <li>
          The preceding license does not permit redistribution, resale,
          lending, or publication of the package itself, or of assets extracted
          from it, on a standalone or substantially identical basis.
        </li>
        <li>
          We may unpublish or stop distributing a package, revoke a purchase,
          or take other appropriate action if we reasonably believe that the
          package violates law or these Terms, infringes
          rights, presents a security risk, or has a material defect.
        </li>
      </ol>

      <h2 className={sectionClass}>8. AI features</h2>
      <ol className={orderedListClass}>
        <li>
          Prompts, images, audio, subtitles, and other input submitted to an AI
          feature are sent to OpenRouter and to the business operating the
          selected model. Do not submit confidential information,
          authentication information, legally sensitive personal information,
          or another person&apos;s personal information unless you have a
          lawful basis and a genuine need to do so.
        </li>
        <li>
          AI output may be inaccurate, incomplete, inappropriate, or similar to
          output provided to someone else. We do not warrant its
          originality, accuracy, legality, fitness for a particular purpose, or
          non-infringement of third-party rights. You are responsible for
          reviewing output and obtaining any required rights before using or
          publishing it.
        </li>
        <li>
          We do not claim ownership of AI input or output. Whether
          rights arise in output, and who owns those rights, depends on
          applicable law, the input, and relevant third-party terms.
        </li>
        <li>
          Do not treat AI output as a substitute for professional medical,
          legal, financial, safety, or other advice. Do not make a decision
          that materially affects a person&apos;s rights or safety solely on AI
          output without appropriate human review.
        </li>
      </ol>

      <h2 className={sectionClass}>9. Prohibited conduct</h2>
      <p className="leading-7 not-first:mt-6">
        You must not engage in any of the following conduct when using the
        Service:
      </p>
      <ul className={listClass}>
        <li>
          Violating law, public policy, these Terms, or an agreement with a
          third party
        </li>
        <li>
          Infringing another person&apos;s intellectual property, privacy,
          publicity rights, reputation, or other rights or interests
        </li>
        <li>
          Processing child sexual exploitation material, unlawful sexual
          content, discrimination, threats, fraud, or other harmful or illegal
          content
        </li>
        <li>
          Publishing a package containing malware, destructive code, or
          undisclosed communication or tracking features
        </li>
        <li>
          Gaining unauthorized access, bypassing authentication, exploiting a
          vulnerability, or interfering with a security feature
        </li>
        <li>
          Circumventing a usage limit, charge, technical restriction, or access
          control
        </li>
        <li>
          Using automated collection, scraping, repeated requests, or other
          activity that places an excessive load on the Service or another User
        </li>
        <li>
          Impersonating another person, registering false information, or
          misusing an account
        </li>
        <li>
          Reselling or providing the Service or any part of it to a third party
          without our permission
        </li>
        <li>Assisting, inducing, or attempting any of the preceding acts</li>
      </ul>

      <h2 className={sectionClass}>
        10. Investigation, removal, and restrictions
      </h2>
      <ol className={orderedListClass}>
        <li>
          When reasonably necessary to comply with law or these Terms, protect
          third-party rights, or secure the Service, we may investigate
          activity, make User Content private, remove content, restrict
          features, suspend an account, or terminate an agreement.
        </li>
        <li>
          When the matter is not urgent, we will, where practicable,
          provide the reason before or after taking action and accept an
          explanation from the User. Notice may be withheld where required for
          legal process, an investigation, security, or protection of
          third-party rights.
        </li>
      </ol>

      <h2 className={sectionClass}>11. Third-party services and packages</h2>
      <ol className={orderedListClass}>
        <li>
          The Service relies on third-party services for payments,
          authentication, email, cloud infrastructure, AI processing, and other
          functions. Those services are governed by their respective terms, and
          an outage, specification change, or discontinuation may make part of
          the Service unavailable.
        </li>
        <li>
          A package supplied by a Publisher is not necessarily created by us.
          Although we work to maintain safety, you must
          review the permissions, source, description, license, and supported
          environment before using a package.
        </li>
      </ol>

      <h2 className={sectionClass}>
        12. Changes, interruptions, and discontinuation
      </h2>
      <ol className={orderedListClass}>
        <li>
          We may change or temporarily interrupt all or part of the
          Service for maintenance, incident response, security, legal
          compliance, changes to third-party services, or another reasonable
          cause. Except in an emergency, we will provide advance
          notice where practicable if the effect on Users is material.
        </li>
        <li>
          If we discontinue the Service or a paid feature, we will provide
          reasonable advance notice and, in accordance
          with law and Additional Terms, take reasonable measures such as
          migration, substitute performance, or a refund for unprovided paid
          service or remaining paid entitlements.
        </li>
      </ol>

      <h2 className={sectionClass}>13. Account termination</h2>
      <ol className={orderedListClass}>
        <li>
          You may delete your account through the designated process in account
          settings. If a payment, refund, AI operation, or storage operation is
          in progress, deletion may be deferred until that operation can be
          completed or canceled safely.
        </li>
        <li>
          After account deletion, you may lose access to cloud files, AI
          history, published packages, your library, and redownload rights.
          Save any data you need before deleting the account.
        </li>
        <li>
          A license for a free or one-time-purchase package lawfully downloaded
          before account deletion survives deletion unless it is revoked due to
          a refund, payment reversal, rights infringement, or breach of these
          Terms.
        </li>
        <li>
          Payment, intellectual property, liability, dispute resolution, and
          other provisions that by their nature should survive remain effective
          after an account ends.
        </li>
      </ol>

      <h2 className={sectionClass}>14. No warranties</h2>
      <ol className={orderedListClass}>
        <li>
          The Service is provided as available. To the fullest extent permitted
          by law, we make no express or implied warranty that the
          Service will always be available without interruption, will operate
          in every environment, will be free from defects or vulnerabilities,
          will preserve or restore every item of data, or that the Service, AI
          output, or published content will be accurate, complete, secure,
          lawful, or fit for a particular purpose.
        </li>
        <li>
          We do not warrant that using or being unable to use the
          Service will cause no loss, or that any resulting loss will be
          compensated. You are responsible for backing up important files and
          work and for using the Service, AI output, and packages at your own
          judgment and risk.
        </li>
        <li>
          This section does not exclude liability that we must bear
          under applicable law.
        </li>
      </ol>

      <h2 className={sectionClass}>15. Our liability</h2>
      <ol className={orderedListClass}>
        <li>
          We are not liable for loss caused by a User&apos;s conduct
          or environment, a Publisher or another third party, a third-party
          service outage or specification change, a communications failure,
          power outage, disaster, law or government action, or any other cause
          not attributable to us.
        </li>
        <li>
          If loss results from our ordinary negligence, we are not liable for
          lost profits or indirect, special, consequential, or data-loss
          damages, and are liable only for direct
          and ordinary loss actually incurred. If the User paid for the relevant
          service during the twelve months before the event causing the loss,
          liability is capped at that amount. This monetary cap does not apply
          where the User paid no consideration for the relevant service.
        </li>
        <li>
          The exclusions and limitations in the preceding two paragraphs do not
          apply to loss caused by our intentional misconduct or gross
          negligence. They also do not apply to the extent that the Consumer
          Contract Act or another mandatory law prohibits the exclusion or
          limitation.
        </li>
      </ol>

      <h2 className={sectionClass}>16. User responsibility</h2>
      <p className="leading-7 not-first:mt-6">
        If a breach of these Terms or infringement of third-party rights caused
        by a matter attributable to a User causes actual loss to us,
        that User is responsible for the direct and ordinary loss.
      </p>

      <h2 className={sectionClass}>17. Privacy</h2>
      <p className="leading-7 not-first:mt-6">
        We handle information about Users in accordance with the
        {" "}
        <Link className={linkClass} href={`/${lang}/docs/privacy`}>
          Privacy Policy
        </Link>
        . Review that policy before using AI features because AI input is sent
        to external AI providers.
      </p>

      <h2 className={sectionClass}>18. Changes to these Terms</h2>
      <ol className={orderedListClass}>
        <li>
          We may amend these Terms under Article 548-4 of the Civil
          Code when an amendment benefits Users generally, or when it is not
          contrary to the purpose of the agreement and is reasonable in light
          of the need for the amendment, the appropriateness of its substance,
          and other relevant circumstances.
        </li>
        <li>
          We will publish the amendment and its effective date through
          the Service. If an amendment materially disadvantages Users, we will
          provide reasonable advance notice by email to the
          registered address or another appropriate method.
        </li>
        <li>
          An amendment that requires individual consent under applicable law
          applies only after that consent is obtained through the designated
          process.
        </li>
      </ol>

      <h2 className={sectionClass}>19. Notices and contact</h2>
      <ol className={orderedListClass}>
        <li>
          We may notify Users by publishing a notice through the
          Service, sending it to a registered email address, or using another
          method we consider appropriate.
        </li>
        <li>
          Send questions about these Terms or the Service, rights-infringement
          reports, and defect reports to contact@beditor.net.
        </li>
      </ol>

      <h2 className={sectionClass}>
        20. Assignment and severability
      </h2>
      <ol className={orderedListClass}>
        <li>
          A User may not assign their status or any right or obligation under
          these Terms to a third party without our prior written
          consent.
        </li>
        <li>
          If any part of these Terms is held invalid or unenforceable, the
          remaining provisions remain in effect.
        </li>
      </ol>

      <h2 className={sectionClass}>21. Governing law and disputes</h2>
      <ol className={orderedListClass}>
        <li>These Terms and the Service are governed by Japanese law.</li>
        <li>
          If a dispute arises, we will first attempt to resolve it with the User
          through good-faith discussion. If the dispute cannot be
          resolved, a court in Japan that has jurisdiction under the Code of
          Civil Procedure or other applicable law will serve as the court of
          first instance.
        </li>
      </ol>

      <h2 className={subSectionClass}>Service provider</h2>
      <p className="leading-7 not-first:mt-6">
        Disclosed without delay upon request.
        <br />
        Contact: contact@beditor.net
      </p>
    </article>
  );
}
