import { brandedEmailHtml, esc } from "./emailLayout";
import { waiverPdfOf } from "./waiverSettings";
const FROM_ADDRESS = process.env.EMAIL_FROM || "RM Roost <onboarding@resend.dev>";

export async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — skipping email to ${to}: ${subject}`);
    return { ok: false, reason: "no_api_key" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[email] Resend error:", err);
      return { ok: false, reason: err };
    }
    return { ok: true };
  } catch (err: any) {
    console.error("[email] Failed to send email:", err?.message ?? err);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

export async function sendSetupEmail(opts: {
  to: string;
  name: string;
  token: string;
  appUrl: string;
  isNew?: boolean;
}) {
  const { to, name, token, appUrl, isNew = true } = opts;
  const url = `${appUrl}/setup-account?token=${token}`;
  const subject = isNew ? "Set up your RM Roost account" : "Reset your RM Roost password";
  const heading = isNew ? "You've been invited to RM Roost" : "Password reset requested";
  const actionLabel = isNew ? "Set Up My Account" : "Reset Password";

  const html = brandedEmailHtml({
    appUrl,
    preheader: isNew ? "Set your password to start running events on RM Roost." : "Choose a new password for your RM Roost account.",
    eyebrow: isNew ? "Organizer invite" : "Password reset",
    heading,
    paragraphs: [
      `Hi ${esc(name)},`,
      isNew
        ? "You've been added as an organizer on RM Roost. Set your password to activate your account, then you can create events, take registrations and run race day."
        : "We received a request to reset your RM Roost password. Click the button below to choose a new one.",
    ],
    button: { label: actionLabel, url },
    note: isNew
      ? "This link expires in 72 hours. If you weren't expecting this invite, you can ignore this email."
      : "This link expires in 72 hours. If you didn't ask to reset your password, you can ignore this email; your password won't change.",
  });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — setup URL for ${to}:`);
    console.warn(`[email] ${url}`);
    return { ok: false, reason: "no_api_key", setupUrl: url };
  }

  const result = await sendEmail(to, subject, html);
  return { ...result, setupUrl: result.ok ? undefined : url };
}

export async function sendDeletionRequestEmail(opts: {
  userEmail: string;
  reason?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { userEmail, reason } = opts;
  const subject = `Account Deletion Request — ${userEmail}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:40px">
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:800;color:#111">Account Deletion Request</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#555"><strong>Email:</strong> ${userEmail}</p>
        <p style="margin:0 0 8px;font-size:15px;color:#555"><strong>Reason:</strong> ${reason ?? "Not provided"}</p>
        <p style="margin:24px 0 0;font-size:13px;color:#999">
          Process this request within 30 days. Delete the account and all associated data from the database,
          then send a confirmation email to ${userEmail}.
        </p>
      </div>
    </div>
  `;
  return sendEmail("support@rockymountainatv.com", subject, html);
}

export async function sendLiabilityWaiverConfirmation(opts: {
  to: string;
  signerName: string;
  eventName: string;
  signedAt: string;
  contentHash: string;
  waiverSnapshot: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { to, signerName, eventName, signedAt, contentHash, waiverSnapshot } = opts;
  const subject = `Your liability waiver — ${eventName}`;
  const formattedDate = new Date(signedAt).toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  // Names come from the signer: escape them. A PDF waiver links to the club's file on our site.
  const safeName = escapeHtml(signerName);
  const safeEvent = escapeHtml(eventName);
  const pdf = waiverPdfOf(waiverSnapshot);
  const pdfHref = pdf ? escapeHtml(pdf.startsWith("/") ? `${(process.env.APP_URL || "https://www.rmroost.com").replace(/\/$/, "")}${pdf}` : pdf) : null;
  const documentSection = pdfHref
    ? `<p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Document you signed</p>
       <div style="background:#f7f7f7;border:1px solid #e5e5e5;border-radius:4px;padding:16px 20px">
         <a href="${pdfHref}" style="color:#2563eb;font-size:14px;word-break:break-all">View Liability Waiver PDF →</a>
       </div>`
    : `<p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Document you signed</p>
       <div style="background:#f7f7f7;border:1px solid #e5e5e5;border-radius:4px;padding:16px 20px;max-height:500px;overflow:hidden">
         <pre style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#333;white-space:pre-wrap;line-height:1.6">${(waiverSnapshot.length > 4000 ? waiverSnapshot.substring(0, 4000) + "\n\n[... full document truncated for email display ...]" : waiverSnapshot).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
       </div>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:40px 24px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden">

        <div style="background:#111;padding:28px 32px">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#dc2626">Liability Waiver — Signed Copy</p>
          <h1 style="margin:0;font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#fff">${safeEvent}</h1>
        </div>

        <div style="padding:28px 32px">
          <p style="margin:0 0 20px;font-size:15px;color:#444;line-height:1.6">
            Hi ${safeName},<br><br>
            This email confirms your legally binding electronic signature on the liability waiver for <strong>${safeEvent}</strong>.
            Keep this email for your records.
          </p>

          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
            <tr style="border-bottom:1px solid #f0f0f0">
              <td style="padding:10px 0;color:#888;width:140px">Signed by</td>
              <td style="padding:10px 0;color:#111;font-weight:600">${safeName}</td>
            </tr>
            <tr style="border-bottom:1px solid #f0f0f0">
              <td style="padding:10px 0;color:#888">Event</td>
              <td style="padding:10px 0;color:#111">${safeEvent}</td>
            </tr>
            <tr style="border-bottom:1px solid #f0f0f0">
              <td style="padding:10px 0;color:#888">Signed at</td>
              <td style="padding:10px 0;color:#111">${formattedDate}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#888;vertical-align:top">Document hash</td>
              <td style="padding:10px 0;color:#555;font-family:monospace;font-size:11px;word-break:break-all">${contentHash}</td>
            </tr>
          </table>

          ${documentSection}

          <p style="margin:20px 0 0;font-size:11px;color:#aaa;line-height:1.5">
            The document hash above is a SHA-256 fingerprint of the exact waiver document you signed.
            It can be used to verify the integrity of this record at any time.
          </p>
        </div>
      </div>
    </div>
  `;

  return sendEmail(to, subject, html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * Rocky escalated a problem: email the RM Roost team with Approve / Decline
 * links (they open a confirm page; the link itself decides nothing) and a link
 * to the ticket. Every value is escaped: the ticket text comes from the chat.
 */
export async function sendSupportTicketEmail(opts: {
  to: string[];
  ticketId: number;
  urgency: "normal" | "urgent";
  summary: string;
  details: string;
  clubName: string | null;
  eventName: string | null;
  reporter: string | null;
  /** Diagnostic tools Rocky ran before escalating. */
  checked: string[];
  approveUrl: string;
  declineUrl: string;
  ticketUrl: string;
}): Promise<{ ok: boolean }> {
  const urgent = opts.urgency === "urgent";
  const subject = `${urgent ? "[URGENT] " : ""}Rocky support request #${opts.ticketId}: ${opts.summary}`.slice(0, 180);
  const row = (label: string, value: string | null) => value
    ? `<tr><td style="padding:4px 12px 4px 0;color:#777;font-size:13px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:4px 0;font-size:13px;color:#222">${escapeHtml(value)}</td></tr>`
    : "";
  const button = (href: string, label: string, bg: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;background:${bg};color:#fff;text-decoration:none;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:1px;border-radius:999px">${label}</a>`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:32px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${urgent ? "#B30000" : "#777"}">
          ${urgent ? "Urgent: racing or check-in is blocked" : "Support request"} · #${opts.ticketId}
        </p>
        <h1 style="margin:0 0 16px;font-size:20px;color:#242424">${escapeHtml(opts.summary)}</h1>
        <table style="border-collapse:collapse;margin-bottom:16px">
          ${row("Club", opts.clubName)}${row("Event", opts.eventName)}${row("Reported by", opts.reporter)}
          ${row("Rocky checked", opts.checked.length ? [...new Set(opts.checked)].join(", ") : "nothing yet")}
        </table>
        <div style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:#333;background:#f6f6f6;border-radius:6px;padding:14px;margin-bottom:20px">${escapeHtml(opts.details)}</div>
        ${button(opts.approveUrl, "Approve investigation", "#B30000")}${button(opts.declineUrl, "Decline", "#555")}
        <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.5">
          Approving marks the request for investigation and tells the organizer the team is on it. Nothing is changed in RM Roost until you fix it.
          The buttons work once and expire in 7 days. <a href="${escapeHtml(opts.ticketUrl)}" style="color:#555">Open the ticket in RM Roost</a> for what Rocky found.
        </p>
      </div>
    </div>`;
  let ok = true;
  // One email per recipient, so team members don't see each other's addresses.
  for (const to of opts.to) {
    const result = await sendEmail(to, subject, html);
    ok = ok && result.ok;
  }
  return { ok };
}

/**
 * A follow-up on a support request (investigation finished, fix ready):
 * heading, plain-text body, optional buttons (confirm-page links) and a link to
 * the ticket. Every value is escaped.
 */
export async function sendSupportUpdateEmail(opts: {
  to: string[];
  subject: string;
  eyebrow: string;
  heading: string;
  body: string;
  buttons: Array<{ href: string; label: string; primary?: boolean }>;
  footer: string;
  ticketUrl: string;
}): Promise<{ ok: boolean }> {
  const buttons = opts.buttons.map(b =>
    `<a href="${escapeHtml(b.href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;background:${b.primary ? "#B30000" : "#555"};color:#fff;text-decoration:none;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:1px;border-radius:999px">${escapeHtml(b.label)}</a>`).join("");
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:32px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#777">${escapeHtml(opts.eyebrow)}</p>
        <h1 style="margin:0 0 16px;font-size:20px;color:#242424">${escapeHtml(opts.heading)}</h1>
        <div style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:#333;background:#f6f6f6;border-radius:6px;padding:14px;margin-bottom:20px">${escapeHtml(opts.body)}</div>
        ${buttons}
        <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.5">
          ${escapeHtml(opts.footer)} <a href="${escapeHtml(opts.ticketUrl)}" style="color:#555">Open the ticket in RM Roost</a> for the full report.
        </p>
      </div>
    </div>`;
  let ok = true;
  for (const to of opts.to) ok = (await sendEmail(to, opts.subject, html)).ok && ok;
  return { ok };
}
