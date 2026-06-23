export default function RiderAppLanding() {
  const deployedHost =
    typeof window !== "undefined" ? window.location.host : "";

  const expsUrl = `exps://${deployedHost}/rider-app/`;

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

        <div className="grid gap-4">
          <div className="border rounded-xl p-6 bg-card text-left space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-sm">1</div>
              <h2 className="font-semibold text-lg">Download Expo Go</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Expo Go is a free app that lets you preview mobile apps.
            </p>
            <div className="flex gap-3">
              <a
                href="https://apps.apple.com/app/id982107779"
                target="_blank"
                rel="noreferrer"
                className="flex-1 text-center text-sm border rounded-lg py-2 px-3 hover:bg-muted transition-colors font-medium"
              >
                📱 App Store
              </a>
              <a
                href="https://play.google.com/store/apps/details?id=host.exp.exponent"
                target="_blank"
                rel="noreferrer"
                className="flex-1 text-center text-sm border rounded-lg py-2 px-3 hover:bg-muted transition-colors font-medium"
              >
                🤖 Google Play
              </a>
            </div>
          </div>

          <div className="border rounded-xl p-6 bg-card text-left space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-sm">2</div>
              <h2 className="font-semibold text-lg">Open in Expo Go</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Tap the button below on your phone to open the app directly in Expo Go.
            </p>
            <a
              href={expsUrl}
              className="block w-full text-center bg-primary text-primary-foreground rounded-lg py-3 font-semibold hover:bg-primary/90 transition-colors"
            >
              Open RM Tracker →
            </a>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Already have the app?{" "}
          <a href={expsUrl} className="underline underline-offset-2 hover:text-foreground">
            Tap here to open it
          </a>
        </p>
      </div>
    </div>
  );
}
