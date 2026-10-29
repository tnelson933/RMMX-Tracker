// A new release has taken over: tell open pages, and let each page decide
// when to reload (src/lib/appUpdates.ts). Reloading them from here sent every
// page back to the address it was first opened at (pushState doesn't change a
// client's URL), e.g. home page → sign in → bounced back to the home page.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) client.postMessage({ type: "rmroost:app-updated" });
    })(),
  );
});
