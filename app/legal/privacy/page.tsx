import type { Metadata } from 'next'
import { COMPANY_NAME, CONTACT_EMAIL, LEGAL_VERSION, SUBPROCESSORS } from '@/lib/legal'

export const metadata: Metadata = { title: 'Privacy Policy — Cogni' }

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Effective version: {LEGAL_VERSION}. This policy explains what {COMPANY_NAME} collects, how it is used, who it is shared with, and your rights.</p>

      <h2>1. What we collect</h2>
      <ul>
        <li><strong>Account data</strong> — your email address and authentication identifiers (and your name/avatar if you sign in with Google).</li>
        <li><strong>Coursework you upload</strong> — syllabi, notes, past exams, and similar materials, plus the data we derive from them (topics, schedules, flashcards, study history).</li>
        <li><strong>Your API keys</strong> — the third-party AI keys you provide, stored encrypted in a dedicated secrets vault and used only to make AI requests on your behalf.</li>
        <li><strong>Usage data</strong> — basic operational logs and per-day feature counters used to enforce rate limits and detect abuse.</li>
      </ul>

      <h2>2. How we use it</h2>
      <p>We use your data solely to provide the Service: to analyze your materials, generate study content, schedule reviews, and operate, secure, and improve the product. We do not sell your data, and we do not use your coursework to train our own models.</p>

      <h2>3. Who we share it with (sub-processors)</h2>
      <p>To run the Service we share data with the following processors. The AI providers are called using <em>your own API key</em>; their handling of your requests is also governed by their terms and your account with them.</p>
      <ul>
        {SUBPROCESSORS.map((s) => (
          <li key={s.name}><strong>{s.name}</strong> — {s.purpose}.</li>
        ))}
      </ul>

      <h2>4. AI providers &amp; data retention</h2>
      <p>When you use AI features, the relevant materials and prompts are sent to Anthropic and/or OpenAI under your own API key. By default, these providers may retain API inputs and outputs for a limited period for abuse-monitoring purposes and do not use API data submitted under standard commercial terms to train their models. Retention and training behavior is governed by your agreement with each provider and the settings on your provider account.</p>

      <h2>5. Storage &amp; security</h2>
      <p>Data is stored with our hosting and database providers (Supabase, Vercel). Access is isolated per user at the database level (row-level security), and your API keys are kept in an encrypted vault separate from ordinary application data.</p>

      <h2>6. Your rights</h2>
      <ul>
        <li><strong>Access / export</strong> — you can export your account data from Settings.</li>
        <li><strong>Deletion</strong> — you can delete your account from Settings at any time. Deletion permanently removes your database records, uploaded files, stored secrets, and authentication record.</li>
        <li><strong>Correction</strong> — you can edit your profile and content in the app.</li>
      </ul>

      <h2>7. Children</h2>
      <p>The Service is not directed to children under the minimum age stated in our <a href="/legal/terms">Terms</a>. We do not knowingly collect data from anyone under that age.</p>

      <h2>8. Changes &amp; contact</h2>
      <p>We may update this policy; material changes are reflected by a new version number. Questions or privacy requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </>
  )
}
