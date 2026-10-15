import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

// GET /api/db-test - verifies the MySQL connection and runs a simple query.
export async function GET() {
  try {
    const rows = await query('Describe emulation_forecast');
    return NextResponse.json({ ok: true, serverTime: rows[0].serverTime });
  } catch (error) {
    console.error('DB connection error:', error);
    return NextResponse.json(
      { ok: false, error: 'Database connection failed' },
      { status: 500 }
    );
  }
}
export async function query_db(sql, params = []) {
  try {
    const rows = await query(sql, params);
    return { ok: true, rows };
  } catch (error) {
    console.error('Query error:', error);
    return { ok: false, error: 'Query failed' };
  }
}