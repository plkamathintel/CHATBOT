import { NextResponse } from 'next/server';
import { runAgent } from '../../../lib/agent';

const MAX_STORED_TURNS = 20;

// POST /api/chat - { message, history? } -> { reply, history }
// History is passed back and forth with the client (no server-side session),
// matching the conversational context the Django view kept in request.session.
export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = (payload?.message || '').trim();
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const history = Array.isArray(payload?.history) ? payload.history : [];

  let reply;
  try {
    reply = await runAgent(message, history);
  } catch (error) {
    console.error('Agent failed:', error);
    return NextResponse.json({ error: `Agent failed: ${error.message}` }, { status: 500 });
  }

  const updatedHistory = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: reply },
  ].slice(-MAX_STORED_TURNS);

  return NextResponse.json({ reply, history: updatedHistory });
}
