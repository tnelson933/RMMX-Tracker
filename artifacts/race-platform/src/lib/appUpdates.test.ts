import assert from "node:assert/strict";
import test from "node:test";

type Listener = (event: any) => void;

/** Minimal browser stand-ins: service worker container, document, history, window. */
function setup({ controlled }: { controlled: boolean }) {
  const swListeners: Listener[] = [];
  const docListeners: Record<string, Listener[]> = {};
  const winListeners: Record<string, Listener[]> = {};
  const state = { reloads: 0, path: "/", visibility: "visible" as "visible" | "hidden" };
  const history = {
    pushState: (_d: unknown, _t: string, url: string) => { state.path = url; },
    replaceState: (_d: unknown, _t: string, url: string) => { state.path = url; },
  };
  // Node has its own read-only navigator: replace it for the test.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        controller: controlled ? {} : null,
        addEventListener: (_: string, fn: Listener) => swListeners.push(fn),
      },
    },
  });
  Object.assign(globalThis, {
    document: {
      get visibilityState() { return state.visibility; },
      addEventListener: (type: string, fn: Listener) => (docListeners[type] ??= []).push(fn),
    },
    history,
    window: {
      location: { reload: () => { state.reloads++; } },
      addEventListener: (type: string, fn: Listener) => (winListeners[type] ??= []).push(fn),
    },
  });
  return {
    state,
    history,
    updated: () => swListeners.forEach(fn => fn({ data: { type: "rmroost:app-updated" } })),
    hide: () => { state.visibility = "hidden"; (docListeners.visibilitychange ?? []).forEach(fn => fn({})); },
  };
}

async function load() {
  // Fresh module per test (each test installs its own globals).
  // @ts-expect-error Node's type-stripping runner requires the explicit extension.
  const mod = await import(`./appUpdates.ts?${Math.random()}`);
  mod.listenForAppUpdates();
}

test("an update never reloads the page out from under the user; it lands on the next page", async () => {
  const b = setup({ controlled: true });
  await load();
  b.history.pushState(null, "", "/login");
  b.updated();
  assert.equal(b.state.reloads, 0, "no reload while on the login form");
  b.history.pushState(null, "", "/dashboard"); // signed in
  assert.equal(b.state.reloads, 1);
  assert.equal(b.state.path, "/dashboard", "reloads into the page being opened, not the home page");
});

test("an update reloads a tab that's in the background", async () => {
  const b = setup({ controlled: true });
  await load();
  b.updated();
  assert.equal(b.state.reloads, 0);
  b.hide();
  assert.equal(b.state.reloads, 1);
});

test("a first visit (no service worker yet) already has the newest code and never reloads", async () => {
  const b = setup({ controlled: false });
  await load();
  b.updated();
  b.history.pushState(null, "", "/login");
  b.hide();
  assert.equal(b.state.reloads, 0);
});
