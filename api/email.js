// Email CSV via Resend (free tier: 100 emails/day)
// Set RESEND_API_KEY in Vercel environment variables
// Sign up at resend.com → get API key → add verified domain or use onboarding@resend.dev

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || "scanner@resend.dev";

  if (!apiKey) {
    return res.status(500).json({
      error: "Email not configured. Add RESEND_API_KEY to Vercel environment variables. Sign up free at resend.com",
    });
  }

  const { to, subject, body, filename, csv } = req.body;

  if (!to || !csv || !filename) {
    return res.status(400).json({ error: "Missing required fields: to, csv, filename" });
  }

  try {
    // Convert CSV string to base64 for attachment
    const csvBase64 = Buffer.from(csv).toString("base64");

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: subject || "Inventory Count Results",
        text: body || "Inventory count CSV attached.",
        attachments: [
          {
            filename: filename,
            content: csvBase64,
          },
        ],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("Resend error:", data);
      return res.status(resp.status).json({
        error: data.message || `Email service returned ${resp.status}`,
      });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error("Email error:", err);
    return res.status(500).json({ error: err.message });
  }
}
