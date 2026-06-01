const FROM_ADDRESS = process.env.EMAIL_FROM || "RMMT Ops <onboarding@resend.dev>";

async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; reason?: string }> {
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
  const subject = isNew ? "Set up your RMMT Ops account" : "Reset your RMMT Ops password";
  const heading = isNew ? "You've been invited to RMMT Ops" : "Password reset requested";
  const actionLabel = isNew ? "Set Up My Account" : "Reset Password";
  const bodyText = isNew
    ? `You've been added as an organizer on RMMT Ops. Click the button below to set your password and activate your account.`
    : `We received a request to reset your RMMT Ops password. Click the button below to choose a new one.`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:40px">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#111">
          ${heading}
        </h1>
        <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6">
          Hi ${name},<br><br>${bodyText}
        </p>
        <a href="${url}"
           style="display:inline-block;padding:14px 28px;background:#dc2626;color:#fff;
                  text-decoration:none;font-weight:700;font-size:14px;text-transform:uppercase;
                  letter-spacing:1px;border-radius:4px">
          ${actionLabel}
        </a>
        <p style="margin:28px 0 0;font-size:12px;color:#999;line-height:1.5">
          This link expires in 72 hours. If you didn't request this you can safely ignore this email.<br>
          Or copy this URL into your browser:<br>
          <span style="word-break:break-all;color:#666">${url}</span>
        </p>
      </div>
    </div>
  `;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — setup URL for ${to}:`);
    console.warn(`[email] ${url}`);
    return { ok: false, reason: "no_api_key", setupUrl: url };
  }

  const result = await sendEmail(to, subject, html);
  return { ...result, setupUrl: result.ok ? undefined : url };
}

export interface MotoResult {
  motoName: string;
  raceClass: string;
  position: number;
  totalTime: string | null;
  lapTimes: string[];
  points: number | null;
  dnf: boolean;
  dns: boolean;
}

export async function sendStatsEmail(opts: {
  to: string;
  riderName: string;
  eventName: string;
  eventDate: string;
  results: MotoResult[];
  resultsUrl: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { to, riderName, eventName, eventDate, results, resultsUrl } = opts;

  const subject = `Your race day stats — ${eventName}`;

  const ordinal = (n: number) => {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  };

  const motoRows = results.map(r => {
    const finishLabel = r.dns ? "DNS" : r.dnf ? "DNF" : ordinal(r.position);
    const finishColor = r.dns || r.dnf ? "#999" : r.position === 1 ? "#dc2626" : "#111";
    const lapTimesHtml = Array.isArray(r.lapTimes) && r.lapTimes.length > 0
      ? r.lapTimes.map((t, i) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;background:#f3f3f3;border-radius:3px;font-size:12px;font-family:monospace;color:#555">L${i + 1}: ${t}</span>`).join("")
      : '<span style="color:#aaa;font-size:13px">No lap data</span>';

    return `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top">
          <div style="font-weight:700;font-size:14px;color:#111">${r.motoName}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;text-transform:uppercase;letter-spacing:0.5px">${r.raceClass}</div>
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:top">
          <span style="font-size:22px;font-weight:800;color:${finishColor}">${finishLabel}</span>
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:top">
          <span style="font-family:monospace;font-size:14px;color:#333">${r.totalTime ?? "—"}</span>
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top">
          ${lapTimesHtml}
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:top">
          <span style="font-weight:700;color:#dc2626">${r.points ?? 0} pts</span>
        </td>
      </tr>
    `;
  }).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 24px;background:#f9f9f9">
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden">

        <div style="background:#111;padding:28px 32px">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#dc2626">Race Day Stats</p>
          <h1 style="margin:0;font-size:24px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#fff">${eventName}</h1>
          <p style="margin:6px 0 0;font-size:13px;color:#888">${eventDate}</p>
        </div>

        <div style="padding:28px 32px 0">
          <p style="margin:0 0 20px;font-size:15px;color:#444;line-height:1.6">
            Hey ${riderName}, here are your results from ${eventName}. Great riding out there!
          </p>
        </div>

        <div style="padding:0 32px 28px;overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="border-bottom:2px solid #111">
                <th style="padding:8px 12px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Moto</th>
                <th style="padding:8px 12px 10px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Finish</th>
                <th style="padding:8px 12px 10px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Total Time</th>
                <th style="padding:8px 12px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Lap Times</th>
                <th style="padding:8px 12px 10px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888">Points</th>
              </tr>
            </thead>
            <tbody>
              ${motoRows}
            </tbody>
          </table>
        </div>

        <div style="padding:20px 32px 32px;border-top:1px solid #f0f0f0">
          <a href="${resultsUrl}"
             style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;
                    text-decoration:none;font-weight:700;font-size:13px;text-transform:uppercase;
                    letter-spacing:1px;border-radius:4px">
            View Full Event Results
          </a>
          <p style="margin:16px 0 0;font-size:12px;color:#aaa">
            You opted in to receive race day stats when you registered. To stop receiving these emails, reply and let us know.
          </p>
        </div>

      </div>
    </div>
  `;

  return sendEmail(to, subject, html);
}
