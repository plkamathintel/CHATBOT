import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

// GET /api/models - preview of the emulation_forecast table, mirrors the Django
// analytical_models_view (SELECT * ... LIMIT 10).
export async function GET() {
  try {
    const rows = await query('SELECT * FROM emulation_forecast LIMIT 10');
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return NextResponse.json({ columns, rows });
  } catch (error) {
    console.error('Failed to load analytical models:', error);
    return NextResponse.json({ error: 'Failed to load data' }, { status: 500 });
  }
}
