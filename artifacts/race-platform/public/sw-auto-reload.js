self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      await Promise.all(
        windows.map((client) => client.navigate(client.url)),
      );
    })(),
  );
});