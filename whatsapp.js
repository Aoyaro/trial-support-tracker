// WhatsApp Cloud API sender.
//
// Reads WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN from the environment.
// If either is missing, the send is NOT attempted against Meta's API: a
// warning is logged and a wa.me fallback URL is returned instead, so the
// trial flow works end-to-end with zero Meta setup.
//
// No credentials are ever invented here. Real sends only happen when the
// deployer explicitly provides real credentials via environment variables.

const GRAPH_VERSION = 'v19.0';

function normalizePhone(phone) {
  // International format without '+': strip spaces, dashes, brackets, leading +/00.
  if (!phone) return '';
  let p = String(phone).trim().replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  return p.replace(/\D/g, '');
}

function waMeUrl(toPhone, messageText) {
  return `https://wa.me/${normalizePhone(toPhone)}?text=${encodeURIComponent(messageText)}`;
}

/**
 * Send a plain-text WhatsApp message via the Cloud API.
 * @returns {Promise<{ok:boolean, autoSent:boolean, waUrl:string|null, messageId?:string, error?:string}>}
 */
async function sendLocationRequest(toPhone, messageText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const to = normalizePhone(toPhone);

  if (!to) {
    return { ok: false, autoSent: false, waUrl: null, error: 'invalid_phone' };
  }

  if (!phoneNumberId || !token) {
    console.warn(
      '[whatsapp] WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN not set — ' +
      'skipping Cloud API send, returning wa.me fallback URL.'
    );
    return { ok: true, autoSent: false, waUrl: waMeUrl(to, messageText), note: 'no_credentials_fallback' };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: messageText },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      console.error('[whatsapp] Cloud API send failed:', errMsg);
      // Still hand back a wa.me fallback so the trial flow is never blocked.
      return { ok: false, autoSent: false, waUrl: waMeUrl(to, messageText), error: errMsg };
    }
    const messageId = data?.messages?.[0]?.id;
    return { ok: true, autoSent: true, waUrl: null, messageId };
  } catch (e) {
    console.error('[whatsapp] Cloud API request error:', e.message);
    return { ok: false, autoSent: false, waUrl: waMeUrl(to, messageText), error: e.message };
  }
}

module.exports = { sendLocationRequest, normalizePhone, waMeUrl };
