export const PDF_JS_WORKER_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs";

const PDF_JS_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.mjs";

export async function loadPdfJs(): Promise<any> {
  return import(/* @vite-ignore */ PDF_JS_MODULE_URL);
}