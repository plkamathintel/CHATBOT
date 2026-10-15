import mysql from 'mysql2/promise';

let pool;

// Reuse a single pool across hot-reloads in dev and across requests in prod.
export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      // Toggle via env while diagnosing the "access denied" issue; some DBaaS instances require TLS.
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

// Always use parameterized queries (params array) to prevent SQL injection.
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}
