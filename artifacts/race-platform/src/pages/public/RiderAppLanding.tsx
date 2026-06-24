export default function RiderAppLanding() {
  const deployedHost =
    typeof window !== "undefined" ? window.location.host : "";

  const appUrl = `https://${deployedHost}/rider-app/`;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="flex flex-col items-center gap-4">
          <img src="/rm-logo.png" alt="RM Tracker" className="w-20 h-20 drop-shadow-lg" />
          <div>
            <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">
              RM Tracker
            </h1>
            <p className="text-muted-foreground mt-1">
              Mobile app for riders — track your laps and results
            </p>
          </div>
        </div>

        <div className="border rounded-xl p-6 bg-card text-left space-y-4">
          <h2 className="font-semibold text-lg">Open on your phone</h2>
          <p className="text-sm text-muted-foreground">
            Open the link below in your phone's browser — no app download required.
          </p>
          <a
            href={appUrl}
            className="block w-full text-center bg-primary text-primary-foreground rounded-lg py-3 font-semibold hover:bg-primary/90 transition-colors"
          >
            Open RM Tracker →
          </a>
          <p className="text-xs text-muted-foreground text-center break-all">
            {appUrl}
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Works in Safari, Chrome, and other mobile browsers.
        </p>
      </div>
    </div>
  );
}
