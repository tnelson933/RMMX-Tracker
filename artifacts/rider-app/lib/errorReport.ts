import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

import { API_BASE_URL } from "@/lib/apiBase";
import {
  buildReport,
  describeError,
  newInstallId,
  ReportGate,
  type ErrorReportMeta,
  type ErrorSource,
} from "@/lib/errorReportCore";

// JS error reports to our API (POST /api/app-errors, logged as `rider_app_error`).
// Works in an over-the-air update: no native crash SDK. Sends no personal data:
// no names, emails, accounts, tokens or request bodies; the route is the
// template ("/racer/[id]"), and the install id is random and per install.
// Fire-and-forget: never throws, never blocks, at most 10 reports a session,
// each distinct error once. Off in development unless
// EXPO_PUBLIC_ERROR_REPORTS_IN_DEV=1.

const INSTALL_ID_KEY = "errorReport.installId";
const PENDING_KEY = "errorReport.pendingFatal";
const enabled = !__DEV__ || process.env.EXPO_PUBLIC_ERROR_REPORTS_IN_DEV === "1";

const gate = new ReportGate();
let currentRoute: string | null = null;
let installId: string | null = null;
let installIdLoading: Promise<string | null> | null = null;

/** Called by the root layout on navigation. */
export function setErrorReportRoute(route: string): void {
  currentRoute = route;
}

function loadInstallId(): Promise<string | null> {
  installIdLoading ??= (async () => {
    try {
      const saved = await AsyncStorage.getItem(INSTALL_ID_KEY);
      if (saved) return (installId = saved);
      const id = newInstallId();
      await AsyncStorage.setItem(INSTALL_ID_KEY, id);
      return (installId = id);
    } catch {
      return null;
    }
  })();
  return installIdLoading;
}

function meta(): ErrorReportMeta {
  return {
    route: currentRoute,
    appVersion: Constants.expoConfig?.version ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    updateId: Updates.updateId ?? null,
    platform: Platform.OS,
    osVersion: Platform.Version != null ? String(Platform.Version).slice(0, 40) : null,
    installId,
  };
}

async function send(body: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE_URL}/api/app-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    return res.ok || (res.status >= 400 && res.status < 500); // a refused report isn't worth retrying
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reports an error. Safe to call from anywhere (catch blocks, handlers): it
 * returns at once and never throws.
 */
export function reportError(
  error: unknown,
  opts: { source?: ErrorSource; fatal?: boolean; context?: string; componentStack?: string } = {},
): void {
  if (!enabled) return;
  try {
    const d = describeError(error);
    if (!gate.take(`${opts.context ?? ""}|${d.name ?? ""}|${d.message}`)) return;
    const build = () => buildReport(error, {
      source: opts.source ?? "caught",
      fatal: opts.fatal,
      context: opts.context,
      extraStack: opts.componentStack,
    }, meta());
    if (opts.fatal) {
      // The app is about to close: keep it on the phone and send on the next start too.
      const body = build();
      AsyncStorage.setItem(PENDING_KEY, body).catch(() => {});
      void send(body).then(ok => { if (ok) AsyncStorage.removeItem(PENDING_KEY).catch(() => {}); });
      return;
    }
    void loadInstallId().then(() => send(build()));
  } catch {
    // Reporting must never cause a second error.
  }
}

/** For a catch block that should never run: report it with a short label, behaviour unchanged. */
export function reportCaught(context: string, error: unknown): void {
  reportError(error, { source: "caught", context });
}

let installed = false;

/** Installs the global handlers once, at app start (app/_layout.tsx). */
export function initErrorReporting(): void {
  if (installed || !enabled) return;
  installed = true;
  try {
    void loadInstallId();
    // A fatal error from last time that couldn't be sent before the app closed.
    AsyncStorage.getItem(PENDING_KEY)
      .then(body => body ? send(body).then(ok => { if (ok) return AsyncStorage.removeItem(PENDING_KEY); }) : undefined)
      .catch(() => {});

    const errorUtils = (globalThis as { ErrorUtils?: typeof ErrorUtils }).ErrorUtils;
    if (errorUtils?.setGlobalHandler) {
      const previous = errorUtils.getGlobalHandler?.();
      errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        reportError(error, { source: "global", fatal: !!isFatal });
        // Always hand on: React Native's handler shows/ends the app as before.
        previous?.(error, isFatal);
      });
    }

    // Unhandled promise rejections. React Native only tracks these in development
    // (for LogBox), so in release builds Hermes' tracker is free to use.
    const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } }).HermesInternal;
    if (!__DEV__ && hermes?.enablePromiseRejectionTracker) {
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => reportError(rejection, { source: "promise" }),
        onHandled: () => {},
      });
    }

    if (Platform.OS === "web" && typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("error", e => reportError(e.error ?? e.message, { source: "global" }));
      window.addEventListener("unhandledrejection", e => reportError(e.reason, { source: "promise" }));
    }
  } catch {
    // Never stop the app from starting.
  }
}
