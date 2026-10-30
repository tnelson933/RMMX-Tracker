/**
 * Terms for RM Roost's text-message program. The wording matches the carrier
 * (A2P 10DLC) registration and the texts the API sends (lib/smsReplies.ts);
 * keep them in step.
 */
export default function TermsAndConditions() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-sm text-gray-700">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms and Conditions</h1>
      <p className="text-gray-500 mb-8">Last updated: October 30, 2026</p>

      <p className="mb-6">
        RM Roost is owned and operated by Rocky Mountain ATV Inc. These terms cover RM Roost
        Support Alerts, the text-message program described below.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">RM Roost Support Alerts (text messages)</h2>
      <ul className="list-disc pl-6 space-y-2 mb-6">
        <li>
          <strong>Program:</strong> RM Roost Support Alerts, sent by Rocky Mountain ATV Inc.
        </li>
        <li>
          <strong>What it is:</strong> internal alerts for RM Roost team members (developers and
          managers). When a site issue reported by an RM Roost user is escalated, the alert
          describes it and links to the details. Recipients can approve or decline the
          investigation, and later the proposed fix, by replying with the ticket number and the
          one-time code in the message (for example "YES 123 K7Q2C" or "NO 123 K7Q2C").
        </li>
        <li>
          <strong>Who receives them:</strong> only team members who agreed in person to receive
          them. Enrollment is confirmed by text.
        </li>
        <li>
          <strong>Message frequency:</strong> up to 8 messages per month.
        </li>
        <li>
          <strong>Message and data rates may apply.</strong>
        </li>
        <li>
          Reply <strong>HELP</strong> for help. Reply <strong>STOP</strong> to opt out at any
          time; you'll receive one message confirming you're unsubscribed. Reply{" "}
          <strong>START</strong> to rejoin.
        </li>
        <li>
          <strong>Support:</strong> email{" "}
          <a href="mailto:sales@rockymountainatv.com" className="text-red-600 underline">sales@rockymountainatv.com</a>{" "}
          or call <a href="tel:+18003365437" className="text-red-600 underline">1-800-336-5437</a>.
        </li>
        <li>
          Carriers are not liable for delayed or undelivered messages.
        </li>
        <li>
          How we handle your number and consent is described in our{" "}
          <a href="/privacy" className="text-red-600 underline">Privacy Policy</a>. We do not sell or
          share your SMS opt-in data or personal information with third parties for marketing
          purposes.
        </li>
      </ul>
    </div>
  );
}
