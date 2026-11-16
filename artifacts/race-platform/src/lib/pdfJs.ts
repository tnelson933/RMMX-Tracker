// pdf.js ships with the app (no CDN), so PDFs render on the website, in the
// rider app's /pdf-view page and in the desktop app with no internet.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export const PDF_JS_WORKER_URL: string = workerUrl;

export async function loadPdfJs(): Promise<any> {
  return import("pdfjs-dist");
}
