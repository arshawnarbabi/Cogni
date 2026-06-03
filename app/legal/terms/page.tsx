import type { Metadata } from 'next'
import { COMPANY_NAME, CONTACT_EMAIL, GOVERNING_LAW, LEGAL_VERSION, MIN_AGE } from '@/lib/legal'

export const metadata: Metadata = { title: 'Terms of Service — Cogni' }

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p>Effective version: {LEGAL_VERSION}. These Terms govern your use of {COMPANY_NAME} (&ldquo;the Service&rdquo;). By creating an account, you agree to them.</p>

      <h2>1. Eligibility</h2>
      <p>You must be at least {MIN_AGE} years old to use the Service. By signing up you attest that you meet this minimum age. The Service is a study aid for your own coursework; it is not a substitute for your institution&rsquo;s instruction, and you are responsible for complying with your school&rsquo;s academic-integrity policies.</p>

      <h2>2. Your account</h2>
      <p>You are responsible for your account credentials and for activity under your account. You provide your own third-party AI API keys (&ldquo;BYOK&rdquo;); you are responsible for the cost, terms, and usage limits of those keys with their respective providers.</p>

      <h2>3. Your content</h2>
      <p>You retain ownership of the materials you upload (syllabi, notes, and other coursework). You grant {COMPANY_NAME} a limited license to store and process that content solely to provide the Service to you — including sending it to the AI providers listed in our <a href="/legal/privacy">Privacy Policy</a> for analysis. You represent that you have the right to upload and process the materials you provide and that doing so does not infringe anyone&rsquo;s rights.</p>

      <h2>4. Acceptable use</h2>
      <p>Your use of the Service is subject to our <a href="/legal/acceptable-use">Acceptable Use Policy</a>. We may suspend or terminate accounts that violate it or that abuse the Service (including attempts to overload, scrape, or circumvent rate limits).</p>

      <h2>5. Availability &amp; changes</h2>
      <p>The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis, without warranties of any kind. We may modify, suspend, or discontinue features at any time. We may update these Terms; material changes will be reflected by a new version number, and continued use after a change constitutes acceptance.</p>

      <h2>6. AI output disclaimer</h2>
      <p>The Service uses AI models that can produce inaccurate or incomplete information. Do not rely on AI-generated study material as authoritative. You are responsible for verifying anything you use for graded work.</p>

      <h2>7. Limitation of liability</h2>
      <p>To the maximum extent permitted by law, {COMPANY_NAME} is not liable for any indirect, incidental, or consequential damages, or for any loss of data, arising from your use of the Service. Our total liability is limited to the amount you paid us in the prior twelve months (which, on the free tier, is zero).</p>

      <h2>8. Termination</h2>
      <p>You may delete your account at any time from Settings, which permanently removes your data as described in the <a href="/legal/privacy">Privacy Policy</a>. We may terminate or suspend access for violations of these Terms.</p>

      <h2>9. Governing law</h2>
      <p>These Terms are governed by the laws of {GOVERNING_LAW}, without regard to conflict-of-law rules.</p>

      <h2>10. Contact</h2>
      <p>Questions about these Terms: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </>
  )
}
