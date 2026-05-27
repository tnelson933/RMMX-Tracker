import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();
const FROM_ADDRESS = process.env.EMAIL_FROM || "RMMT Ops <onboarding@resend.dev>";

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

  try {
    const res = await connectors.proxy("resend", "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        html: `
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
        `,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[email] Resend error:", err);
      return { ok: false, reason: err, setupUrl: url };
    }

    return { ok: true };
  } catch (err: any) {
    console.error("[email] Failed to send via Resend connector:", err?.message ?? err);
    console.warn("[email] Setup URL (fallback log):", url);
    return { ok: false, reason: String(err?.message ?? err), setupUrl: url };
  }
}
