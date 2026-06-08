import { useState, useRef } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  UploadCloud, ArrowLeft, CheckCircle2, XCircle, FileArchive, Loader2, AlertTriangle,
} from "lucide-react";

type UploadState = "idle" | "uploading" | "success" | "error";

export default function OfflineSync() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [message, setMessage] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File | undefined) => {
    if (!f) return;
    const ext = f.name.toLowerCase();
    if (!ext.endsWith(".db") && !ext.endsWith(".zip")) {
      setUploadState("error");
      setMessage("Only .db and .zip files are accepted.");
      return;
    }
    setFile(f);
    setUploadState("idle");
    setMessage("");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleSubmit = async () => {
    if (!file) return;
    setUploadState("uploading");
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("export", file);
      const res = await fetch("/api/offline/sync-upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setUploadState("success");
        setMessage(data.message ?? "Upload received successfully.");
      } else {
        setUploadState("error");
        setMessage(data.error ?? "Upload failed. Please try again.");
      }
    } catch (err: any) {
      setUploadState("error");
      setMessage(err.message ?? "Network error. Please try again.");
    }
  };

  const reset = () => {
    setFile(null);
    setUploadState("idle");
    setMessage("");
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <Link href="/offline-mode" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft size={14} /> Back to Offline Mode
        </Link>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
          <UploadCloud className="text-primary" size={32} /> Sync from Offline Export
        </h1>
        <p className="text-muted-foreground mt-1">
          Upload the SQLite export from your local race server to sync results to the cloud.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center gap-2">
            <FileArchive size={18} className="text-primary" />
            <h2 className="text-base font-heading font-bold uppercase tracking-tight">Upload Export File</h2>
          </div>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>After running <code className="bg-muted rounded px-1 font-mono text-xs">npm run sync</code> on your local server, upload the exported file here.</p>
            <p>Accepted formats: <code className="bg-muted rounded px-1 font-mono text-xs">.db</code> (SQLite database) or <code className="bg-muted rounded px-1 font-mono text-xs">.zip</code> (compressed export).</p>
          </div>

          {uploadState !== "success" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              className={`relative rounded-xl border-2 border-dashed p-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors
                ${dragOver ? "border-primary bg-primary/10" : "border-border hover:border-primary/50 hover:bg-muted/30"}
                ${file ? "border-primary/50 bg-primary/5" : ""}
              `}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".db,.zip"
                className="sr-only"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              {file ? (
                <>
                  <FileArchive size={32} className="text-primary" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">{file.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{(file.size / 1024).toFixed(1)} KB — click to change</p>
                  </div>
                </>
              ) : (
                <>
                  <UploadCloud size={32} className="text-muted-foreground" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">Drop your export file here</p>
                    <p className="text-xs text-muted-foreground mt-0.5">or click to browse — .db or .zip</p>
                  </div>
                </>
              )}
            </div>
          )}

          {uploadState === "error" && (
            <div className="flex items-start gap-3 rounded-lg border-2 border-destructive/40 bg-destructive/10 p-4 text-sm">
              <XCircle size={16} className="text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-destructive">Upload failed</p>
                <p className="text-foreground/80 mt-0.5">{message}</p>
              </div>
            </div>
          )}

          {uploadState === "success" && (
            <div className="rounded-xl border-2 border-green-500/40 bg-green-500/10 p-6 flex flex-col items-center gap-3 text-center">
              <CheckCircle2 size={40} className="text-green-500" />
              <div>
                <p className="font-heading font-bold text-lg uppercase tracking-tight text-green-700 dark:text-green-400">Upload received</p>
                <p className="text-sm text-foreground/80 mt-1">{message}</p>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-left mt-2 max-w-sm">
                <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-foreground/80">
                  Keep your local <code className="bg-background rounded px-0.5 font-mono">race_data.db</code> file until you have confirmed the sync is complete and results appear publicly.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={reset} className="mt-1">Upload another file</Button>
            </div>
          )}

          {uploadState !== "success" && (
            <div className="flex items-center gap-3">
              <Button
                onClick={handleSubmit}
                disabled={!file || uploadState === "uploading"}
                className="font-heading font-bold uppercase tracking-wider"
              >
                {uploadState === "uploading" ? (
                  <><Loader2 size={14} className="animate-spin mr-2" /> Uploading…</>
                ) : (
                  <><UploadCloud size={14} className="mr-2" /> Upload Export</>
                )}
              </Button>
              {file && uploadState !== "uploading" && (
                <Button variant="ghost" size="sm" onClick={reset}>Clear</Button>
              )}
              {uploadState === "uploading" && (
                <Badge variant="secondary" className="text-xs animate-pulse">Uploading — please wait</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-5">
          <div className="flex items-start gap-3 text-sm">
            <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1 text-muted-foreground">
              <p className="font-semibold text-foreground">What happens after upload?</p>
              <p>
                Your export file is received and queued for import. An admin will process it and merge
                the race data into the live database. Results will appear on the public results page
                once the import is complete.
              </p>
              <p>
                For time-sensitive events, contact your platform administrator after uploading to
                expedite processing.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
