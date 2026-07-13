export default function PrivacyPolicy() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-sm text-gray-700">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
      <p className="text-gray-500 mb-8">Last updated: July 11, 2026</p>

      <p className="mb-6">
        Rocky Mountain ATV/MC Race Platform ("RM Tracker", "we", "our", or "us") operates the RM
        Tracker mobile application and web platform. This policy explains what information we
        collect, how we use it, and your rights.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Information We Collect</h2>
      <ul className="list-disc pl-6 space-y-2 mb-6">
        <li><strong>Account information:</strong> name, email address, and password when you register.</li>
        <li><strong>Rider profile:</strong> racing class, club memberships, and race history you add to your profile.</li>
        <li><strong>Device information:</strong> device type, operating system, and push notification token to send you race alerts.</li>
        <li><strong>Usage data:</strong> pages visited and features used to improve the app.</li>
      </ul>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">How We Use Your Information</h2>
      <ul className="list-disc pl-6 space-y-2 mb-6">
        <li>To operate and maintain your account and race registrations.</li>
        <li>To send push notifications about race schedules, results, and updates you opt in to.</li>
        <li>To display public race results and series standings.</li>
        <li>To improve the platform and fix issues.</li>
      </ul>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Sharing of Information</h2>
      <p className="mb-6">
        We do not sell your personal information. We share data only with the club organizers
        running events you register for, and with service providers (hosting, email delivery)
        necessary to operate the platform. Race results and standings are displayed publicly by
        default.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Push Notifications</h2>
      <p className="mb-6">
        If you grant permission, we send push notifications about events and results. You can
        disable notifications at any time in your device settings or in the app's Profile tab.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Data Retention</h2>
      <p className="mb-6">
        We retain your account data for as long as your account is active. You may request
        deletion of your account and associated data by contacting us.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Children's Privacy</h2>
      <p className="mb-6">
        The app is not directed to children under 13. We do not knowingly collect personal
        information from children under 13.
      </p>

      <h2 className="text-xl font-semibold text-gray-900 mt-8 mb-3">Contact Us</h2>
      <p className="mb-6">
        Questions about this policy? Email us at{" "}
        <a href="mailto:support@rockymountainatv.com" className="text-red-600 underline">
          support@rockymountainatv.com
        </a>.
      </p>
    </div>
  );
}
