import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, Code2, ExternalLink } from "lucide-react";
import { getPublicOrigin } from "@/lib/publicOrigin";

interface Props {
  seriesId: number;
}

export function EmbedSeriesWidgetCard({ seriesId }: Props) {
  const [copied, setCopied] = useState(false);
  const [previewSize, setPreviewSize] = useState<"sm" | "md" | "lg">("md");

  const origin = getPublicOrigin();
  const widgetUrl = `${origin}/widget/series/${seriesId}`;

  const sizes = {
    sm: { w: "100%", h: "480" },
    md: { w: "100%", h: "640" },
    lg: { w: "100%", h: "800" },
  };

  const embedCode = `<iframe
  src="${widgetUrl}"
  width="${sizes[previewSize].w}"
  height="${sizes[previewSize].h}"
  frameborder="0"
  style="border-radius: 12px; overflow: hidden; border: none;"
  title="Series Standings"
></iframe>`;

  const copy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const previewHeights = { sm: 400, md: 520, lg: 660 };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 pb-3 border-b">
        <Code2 size={18} className="text-primary" />
        <CardTitle className="font-heading uppercase text-xl">Series Widget</CardTitle>
        <a
          href={widgetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ExternalLink size={13} />
          Open standalone
        </a>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Embed this championship standings widget on your club website. Riders can view overall series points, click into any race for full results and lap times, and see each rider's AMA # and bike.
        </p>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Height:</span>
          {(["sm", "md", "lg"] as const).map(s => (
            <button
              key={s}
              onClick={() => setPreviewSize(s)}
              className={`px-3 py-1 rounded text-xs font-heading font-bold uppercase tracking-wider transition-colors ${
                previewSize === s
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "sm" ? "Small (480px)" : s === "md" ? "Medium (640px)" : "Large (800px)"}
            </button>
          ))}
        </div>

        <div className="rounded-lg overflow-hidden border border-border bg-muted/20">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/40">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
            </div>
            <span className="text-xs text-muted-foreground font-mono truncate flex-1">{widgetUrl}</span>
          </div>
          <iframe
            src={widgetUrl}
            style={{ width: "100%", height: previewHeights[previewSize], border: "none", display: "block" }}
            title="Series Widget Preview"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Embed Code</span>
            <Button variant="outline" size="sm" onClick={copy} className="h-7 gap-1.5 text-xs">
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <pre className="bg-muted/50 rounded-lg p-3 text-xs font-mono text-muted-foreground overflow-x-auto border border-border whitespace-pre-wrap break-all">
            {embedCode}
          </pre>
        </div>

        <p className="text-xs text-muted-foreground/70">
          Paste this code into any page on your website. No login required — the widget is publicly accessible.
        </p>
      </CardContent>
    </Card>
  );
}
