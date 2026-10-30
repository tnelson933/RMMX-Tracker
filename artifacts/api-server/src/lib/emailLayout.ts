/**
 * RM Roost's branded email layout (Rocky Mountain ATV/MC design system:
 * charcoal #242424, brand red #B30000, Barlow headings, pill buttons), matching
 * the website. Tables and inline styles so it renders in Gmail, Outlook and
 * phone mail apps; Barlow loads where the client allows, Arial otherwise.
 */

const CHARCOAL = "#242424";
const RED = "#B30000";
const INK = "#1a1a1a";
const MUTED = "#5c5c5c";
const LIGHT = "#8c8c8c";
const PAGE = "#ececec";

/** Images must come from a public address; local dev URLs wouldn't load in an inbox. */
export function emailAssetBase(appUrl?: string): string {
  const base = (appUrl ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  return /^https:\/\//.test(base) && !/localhost/.test(base) ? base : "https://www.rmroost.com";
}

/** Escape text placed in the email's HTML. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface BrandedEmail {
  /** Shown after the subject in the inbox list. */
  preheader: string;
  /** Small red label above the heading, e.g. "Organizer invite". */
  eyebrow: string;
  heading: string;
  /** Paragraphs of HTML (escape any user text with esc()). */
  paragraphs: string[];
  button: { label: string; url: string };
  /** Small print under the button (HTML). */
  note?: string;
  appUrl?: string;
}

export function brandedEmailHtml(e: BrandedEmail): string {
  const assets = emailAssetBase(e.appUrl);
  const site = assets;
  const font = "'Barlow', 'Helvetica Neue', Arial, sans-serif";
  const heading = "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(e.heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">${esc(e.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;">
      <tr><td align="center" style="background:${CHARCOAL};padding:22px 24px 18px;">
        <a href="${site}" style="text-decoration:none;"><img src="${assets}/brand/rm-roost-banner-640.png" width="240" height="75" alt="RM Roost" style="display:block;border:0;width:240px;height:auto;"></a>
      </td></tr>
      <tr><td style="background:${RED};height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
      <tr><td style="padding:36px 36px 8px;font-family:${font};">
        <p style="margin:0 0 6px;font-family:${heading};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${RED};">${esc(e.eyebrow)}</p>
        <h1 style="margin:0 0 18px;font-family:${heading};font-size:30px;line-height:1.1;font-weight:800;text-transform:uppercase;color:${INK};">${esc(e.heading)}</h1>
        ${e.paragraphs.map(p => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${MUTED};">${p}</p>`).join("\n        ")}
      </td></tr>
      <tr><td align="left" style="padding:8px 36px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${RED}" style="border-radius:999px;">
            <a href="${e.button.url}" style="display:inline-block;padding:15px 34px;font-family:${heading};font-size:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(e.button.label)}</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:0 36px 32px;font-family:${font};">
        ${e.note ? `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${LIGHT};">${e.note}</p>` : ""}
        <p style="margin:0;font-size:12px;line-height:1.5;color:${LIGHT};">Button not working? Paste this link into your browser:<br><a href="${e.button.url}" style="color:${MUTED};word-break:break-all;">${esc(e.button.url)}</a></p>
      </td></tr>
      <tr><td style="background:${CHARCOAL};padding:20px 36px;font-family:${font};">
        <p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:#d0d0d0;"><a href="${site}" style="color:#ffffff;font-weight:600;text-decoration:none;">rmroost.com</a> &nbsp;·&nbsp; Race management for motocross, supercross and enduro</p>
        <p style="margin:0;font-size:11px;line-height:1.5;color:${LIGHT};">RM Roost is owned and operated by Rocky Mountain ATV Inc.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
