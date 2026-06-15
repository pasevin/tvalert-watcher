// Pluggable email sender for magic-link sign-in.
//
// In production set RESEND_API_KEY (https://resend.com) and MAIL_FROM. If no
// provider key is configured, falls back to logging the link to the console so
// the sign-in flow is fully testable in development without an email account.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "TradingView Alerts <onboarding@resend.dev>";

export async function sendMagicLink(email, link) {
  if (!RESEND_API_KEY) {
    console.log("[mailer:dev] no RESEND_API_KEY set — magic link for", email, "→", link);
    return { delivered: false, dev: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [email],
      subject: "Your TradingView Alerts sign-in link",
      html: `
        <div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto">
          <h2 style="margin:0 0 12px">Sign in to TradingView Alerts</h2>
          <p style="color:#444;line-height:1.5">Click the button below to finish signing in. This link expires in 15 minutes.</p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#0a84ff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a>
          </p>
          <p style="color:#999;font-size:13px">If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend failed: HTTP ${res.status} ${text}`);
  }
  return { delivered: true };
}
