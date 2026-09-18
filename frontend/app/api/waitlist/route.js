import { NextResponse } from 'next/server';
import { normaliseSignup } from '../../../lib/prelaunch.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/waitlist — the pre-launch "notify me" form.
 *
 * Adds the contact to a Brevo list (the same Brevo account the backend uses
 * for transactional mail), so launch-day mail goes out from a tool that already
 * exists rather than a CSV someone has to find. Idempotent: an email already on
 * the list is a success, not an error — people click twice.
 *
 * Env (set on Vercel): BREVO_API_KEY, BREVO_WAITLIST_LIST_ID (numeric).
 * Without them the route answers 503 and the form shows the mailto fallback —
 * never a silent "saved" that saved nothing.
 */
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = null; }
  const s = normaliseSignup(body);
  if (!s.ok) return NextResponse.json({ error: s.error }, { status: 400 });
  if (s.bot) return NextResponse.json({ ok: true, message: "You're on the list." });

  const key = process.env.BREVO_API_KEY;
  const listId = Number(process.env.BREVO_WAITLIST_LIST_ID);
  if (!key || !Number.isInteger(listId)) {
    console.error('[waitlist] BREVO_API_KEY / BREVO_WAITLIST_LIST_ID not set');
    return NextResponse.json({ error: 'The list is not taking names right now.' }, { status: 503 });
  }

  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      email: s.email,
      listIds: [listId],
      updateEnabled: true,
      attributes: { ROLE: s.role, SOURCE: 'zoqstudio.ai prelaunch', SIGNED_UP: new Date().toISOString().slice(0, 10) },
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));

  // 201 created · 204 updated (updateEnabled) · 400 duplicate_parameter = already there.
  if (r.ok || r.status === 204) return NextResponse.json({ ok: true, message: "You're on the list." });
  const detail = await r.text().catch(() => '');
  if (r.status === 400 && /duplicate/i.test(detail)) return NextResponse.json({ ok: true, message: "You're already on the list." });

  console.error('[waitlist] brevo', r.status, detail.slice(0, 300));
  return NextResponse.json({ error: 'Could not save that just now.' }, { status: 502 });
}
