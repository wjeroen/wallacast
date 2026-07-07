// Minimal email sender for operational mail (currently only password resets).
// Talks to Resend's HTTP API directly, no SDK dependency. Configuration:
//   RESEND_API_KEY - enables sending. Unset (the default) makes email features
//                    report themselves as unavailable instead of failing silently.
//   EMAIL_FROM     - sender address. Defaults to Resend's shared onboarding sender,
//                    which works without any domain setup (fine for low volume).

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || '').trim();
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = (process.env.EMAIL_FROM || '').trim() || 'Wallacast <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
}
