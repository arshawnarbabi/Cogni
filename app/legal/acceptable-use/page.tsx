import type { Metadata } from 'next'
import { CONTACT_EMAIL, LEGAL_VERSION } from '@/lib/legal'

export const metadata: Metadata = { title: 'Acceptable Use Policy — Cogni' }

export default function AcceptableUsePage() {
  return (
    <>
      <h1>Acceptable Use Policy</h1>
      <p>Effective version: {LEGAL_VERSION}. This policy lists what you may not do with Cogni. Violations may result in suspension or termination.</p>

      <h2>You may not:</h2>
      <ul>
        <li>Upload, generate, or store content that is illegal, or that sexually exploits or endangers minors. We screen uploaded images and report unlawful content as required by law.</li>
        <li>Upload content you do not have the right to use, or that infringes intellectual-property or privacy rights.</li>
        <li>Use the Service to harass, threaten, or harm others, or to generate hateful or abusive material.</li>
        <li>Attempt to overload, scrape, or disrupt the Service, circumvent rate limits or access controls, or access other users&rsquo; data.</li>
        <li>Probe, scan, or reverse-engineer the Service except as permitted by law, or use it to develop a competing product by automated extraction.</li>
        <li>Use the Service to violate your institution&rsquo;s academic-integrity rules, or to misrepresent AI-generated work as your own where prohibited.</li>
        <li>Share your account, or use automated means to create accounts in bulk.</li>
      </ul>

      <h2>Enforcement</h2>
      <p>We may remove content, suspend accounts, and preserve records of violations. Serious or unlawful violations may be reported to the appropriate authorities.</p>

      <h2>Reporting</h2>
      <p>To report abuse or a violation, contact <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </>
  )
}
