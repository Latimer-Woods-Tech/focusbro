// ════════════════════════════════════════════════════════════
// THE PRIVACY POLICY — one source for what FocusBro collects and why
// ════════════════════════════════════════════════════════════
// Served by the Worker at /privacy.html. public/privacy.html and the in-app
// privacy modal in public/index.html carry the same sections (privacy.test.js
// holds them to it). Every statement here is checked against the code that does
// the thing — say what the code does, nothing more:
//   phone + texts ........ consent.js (POST /api/consent, inbound webhook),
//                          checkins-cron.js deliverText → api.telnyx.com
//   browser push ......... push-routes.js (push_subscriptions), webpush.js
//                          (RFC 8291 encrypted payload to the browser's endpoint)
//   app notifications .... native-bridge.js (Capacitor LocalNotifications)
//   payments ............. pro.js (Checkout Session; pro_purchases row)
//   email ................ account-recovery.js → api.resend.com
//   usage events ......... events.js (analytics_events, first-party D1)
//   coach sharing ........ coach.js, coach_note_consent
//   deletion ............. account-delete.js (/account/delete)

export const PRIVACY_LAST_UPDATED = 'October 5, 2026';

/** [heading, html] pairs, in order. Headings are asserted by the tests. */
export function privacySections() {
  return [
    ['Data stored in your browser',
      '<p>By default, the content you create in FocusBro &mdash; timer history, notes, gratitude entries, and preferences &mdash; is stored locally in your browser using <em>localStorage</em>. This data stays on your device, is not transmitted to us, and is cleared when you clear your browser storage.</p>'],
    ['Your account',
      '<p>An account is optional. If you start one, we store your email address and your password &mdash; only as a salted hash, never the password itself. You can also start without an email (a guest account); then we store a random account id and nothing that identifies you. If you sign in, we set one essential session cookie so you stay signed in.</p>'],
    ['Your words and check-ins',
      '<p>When you give your word, we store what you said you&rsquo;ll do, when, your time zone, how often it repeats, and the tone you picked. When a check-in comes, we store your answer, any note you add, and your kept-word streak. If you turn on sync, we store the app data you choose to back up and the name of each device you sync from.</p>'],
    ['Phone number and text messages',
      '<p>Only if you turn on text check-ins and agree to receive texts. Then we store your mobile number, the exact wording you agreed to and when, and your quiet hours. We use the number only to send the check-ins and follow-up texts you chose, and to read your replies (for example &ldquo;done&rdquo; or &ldquo;later&rdquo;) so we can record the check-in; we keep a copy of each reply so it is handled exactly once. Texts are sent and received through <strong>Telnyx</strong>, our text-message provider, which handles your number and the message text to deliver them. Before any text goes out we send a one-time code to the number and ask you to enter it; a number is used for texts only once you have confirmed it, and a confirmed number belongs to one account. Reply STOP at any time and we stop texting you; message and data rates may apply. We never use your number for marketing and never sell or share it for anyone else&rsquo;s marketing.</p>'],
    ['Notifications',
      '<p><strong>In a browser:</strong> if you allow notifications, your browser gives us a push address and keys, which we store so we can send your check-in reminders. Reminders travel through your browser maker&rsquo;s push service (for example Google, Mozilla, or Apple), encrypted so that only your browser can read them.</p>'
      + '<p><strong>In the FocusBro app:</strong> check-in reminders are scheduled on your phone as local notifications. They are not sent through any third-party push service.</p>'],
    ['Coaches',
      '<p>If you accept a coach&rsquo;s invitation, that coach can see your words by title &mdash; the text you wrote, such as &ldquo;take my meds&rdquo; &mdash; for both the ones you are working on and the ones you kept, along with when and how often each repeats and your time zone. The coach also sees counts and dates: how many check-ins were delivered to you, how many you kept, how many you snoozed, and a short read of your week with a gentle cue when you have been away or are back. Your own notes reach a coach only if you turn on note sharing, and you can turn it off at any time. A coach also sets the voice and the opening line of the check-ins you get from them, so their wording shapes the messages you receive.</p>'],
    ['Payments',
      '<p>FocusBro Pro is a one-time purchase on the website, processed by <strong>Stripe</strong>. You enter card details on Stripe&rsquo;s page, never ours; we never see or store card numbers. We receive and store the purchase status, amount, currency, date, and Stripe&rsquo;s reference for the purchase. If your account has an email address, we give it to Stripe for your receipt. Stripe keeps its own payment records under its privacy policy.</p>'],
    ['Email',
      '<p>If your account has an email address, we use it only for account emails, such as verifying the address and resetting your password. These are sent through <strong>Resend</strong>, our email provider.</p>'],
    ['Usage events',
      '<p>When you are signed in, we record what happens in the app (for example a word given, a check-in answered, a focus session finished) with your account id, in our own database. We use it to see whether FocusBro actually helps people follow through. It is not sent to any analytics company.</p>'
      + '<p>Aggregate campaign visit counts come from tagged links. We store the campaign labels, not a visitor ID, fingerprint, task, email, or contact information.</p>'],
    ['Hosting, analytics, and logs',
      '<p>FocusBro runs on <strong>Cloudflare</strong>, which hosts the app and the database. Visit counts come from Cloudflare Web Analytics, which does not use cookies or identify you. Like most websites, requests may be logged briefly with IP address and browser type for security and reliability, and sign-in attempts are counted against your IP address for a short time to stop password guessing; those counters expire on their own.</p>'],
    ['Cookies and ads',
      '<p>FocusBro shows no ads and uses no advertising or tracking cookies. The only cookie is the essential session cookie that keeps you signed in; it is not used for anything else.</p>'],
    ['How long we keep data',
      '<p>We keep your account data for as long as you have the account. When you delete the account, it and the data stored with it are deleted right away. The one exception: if you bought Pro, we keep the purchase record (amount, currency, date, and Stripe&rsquo;s reference) for tax records, with the link to you removed. Our database provider keeps point-in-time backups for up to 30 days, after which deleted data is gone from them too.</p>'],
    ['Deleting your account',
      '<p>You can delete your account and its data yourself at any time: sign in, open Your word, and choose Delete my account &mdash; on the website or in the app. If you can&rsquo;t sign in, see <a href="/account/delete">how to request deletion</a>.</p>'],
    ['Your rights (GDPR)',
      '<p>If you are in the European Economic Area or the UK, you have the right to access, correct, export, restrict, or delete the personal data we hold, to object to certain processing, and to withdraw consent at any time. To exercise these rights, email <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>'],
    ['Your rights (CCPA)',
      '<p>If you are a California resident, you have the right to know what personal information is collected, to request deletion, and to opt out of the &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; of personal information as those terms are defined by the CCPA/CPRA. We do not sell or share your personal information. To make a request, email <a href="mailto:support@focusbro.net">support@focusbro.net</a>.</p>'],
    ['Children',
      '<p>FocusBro is not directed to children under 13, and we do not knowingly collect personal information from them. If you believe a child under 13 has given us personal information, email <a href="mailto:support@focusbro.net">support@focusbro.net</a> and we will delete it.</p>'],
    ['Changes to this policy',
      '<p>We may update this policy as the service changes. Material changes are reflected by updating the &ldquo;Last updated&rdquo; date above.</p>'],
    ['Contact',
      '<p>Privacy questions or data requests: <a href="mailto:support@focusbro.net">support@focusbro.net</a>. FocusBro is operated by Latimer Woods Tech.</p>'],
  ];
}

/** The policy body (everything below the page nav), shared by the Worker page. */
export function privacyPolicyBody() {
  return `<h1>Privacy Policy</h1>
<p><strong>Last updated: ${PRIVACY_LAST_UPDATED}</strong></p>

<p>FocusBro (focusbro.net and the FocusBro app) is a focus and wellness app operated by Latimer Woods Tech. This policy explains what data we handle, why, who helps us handle it, and the choices and rights you have.</p>

${privacySections().map(([h, body]) => `<h2>${h}</h2>\n${body}`).join('\n\n')}`;
}

/** GET /privacy.html */
export function renderPrivacyPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FocusBro Privacy Policy</title><meta name="description" content="What FocusBro stores and why: your account, words and check-ins, phone number and texts, notifications, payments, deletion, and your rights." /></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.65;color:#111827;">
<nav style="font-size:14px;color:#374151;"><a href="/">Home</a> | <a href="/terms.html">Terms</a> | <a href="/about.html">About</a> | <a href="/contact.html">Contact</a> | <a href="/account/delete">Delete your account</a></nav>
${privacyPolicyBody()}
</body></html>`;
}
