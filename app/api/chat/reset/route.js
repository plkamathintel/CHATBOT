import { NextResponse } from 'next/server';

// POST /api/chat/reset - no-op since history is client-managed (no server session),
// kept for parity with the Django app's reset endpoint.
export async function POST() {
  return NextResponse.json({ status: 'ok' });
}
