// Port of push_db.py's MCP tools, called directly as in-process functions instead
// of over the MCP stdio protocol (no separate server process needed in Next.js).
import { query } from './db';

const TABLE = 'emulation_forecast';

// Below this similarity score, a fuzzy match is considered unreliable and is not
// auto-applied (the original value is used as-is, so the query simply finds no
// matching rows rather than silently substituting something unrelated).
const FUZZY_MATCH_CUTOFF = 0.5;

function normalize(value) {
  return String(value).toLowerCase().trim().replace(/[\s\-_/]+/g, ' ');
}

// Simple edit-distance based similarity ratio (0-1, higher = more similar),
// standing in for Python's difflib.SequenceMatcher.ratio().
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarityRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

async function getValidColumns() {
  const rows = await query(`DESCRIBE \`${TABLE}\``);
  return rows.map((row) => row.Field);
}

function assertValidColumn(column, validColumns) {
  if (!validColumns.includes(column)) {
    const error = new Error(`'${column}' is not a valid column. Valid columns: ${validColumns.join(', ')}`);
    error.isValidationError = true;
    throw error;
  }
}

async function fetchDistinct(column) {
  const rows = await query(
    `select distinct \`${column}\` from \`${TABLE}\` where \`${column}\` is not null`
  );
  return rows.map((row) => row[column]);
}

function fuzzyCandidates(distinctValues, keyword, limit = 5) {
  const normQuery = normalize(keyword);
  const scored = distinctValues.map((value) => {
    const normValue = normalize(String(value));
    let score = similarityRatio(normQuery, normValue);
    if (normQuery && (normValue.includes(normQuery) || normQuery.includes(normValue))) {
      score = Math.max(score, 0.9);
    }
    return { score, value };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score, value }) => ({ value, score: Math.round(score * 1000) / 1000 }));
}

async function resolveValue(column, value) {
  if (!value) return [value, null];

  const normValue = normalize(String(value));
  const distinctValues = await fetchDistinct(column);

  for (const candidate of distinctValues) {
    if (normalize(String(candidate)) === normValue) {
      return [candidate, null];
    }
  }

  let bestScore = 0;
  let bestValue = null;
  for (const candidate of distinctValues) {
    const normCandidate = normalize(String(candidate));
    let score = similarityRatio(normValue, normCandidate);
    if (normValue.includes(normCandidate) || normCandidate.includes(normValue)) {
      score = Math.max(score, 0.85);
    }
    if (score > bestScore) {
      bestScore = score;
      bestValue = candidate;
    }
  }

  if (bestValue !== null && bestScore >= FUZZY_MATCH_CUTOFF) {
    const note = `Interpreted "${value}" as "${bestValue}" (closest match in ${column}, score=${Math.round(bestScore * 100) / 100})`;
    return [bestValue, note];
  }

  return [value, null];
}

async function buildNameFilters({ projectName, orgName, ddName } = {}) {
  const whereClauses = [];
  const params = [];
  const notes = [];

  if (projectName) {
    const [resolved, note] = await resolveValue('projectName', projectName);
    whereClauses.push('`projectName` = ?');
    params.push(resolved);
    if (note) notes.push(note);
  }
  if (orgName) {
    const [resolved, note] = await resolveValue('orgName', orgName);
    whereClauses.push('`orgName` = ?');
    params.push(resolved);
    if (note) notes.push(note);
  }
  if (ddName) {
    const [resolved, note] = await resolveValue('ddName', ddName);
    whereClauses.push('`ddName` = ?');
    params.push(resolved);
    if (note) notes.push(note);
  }

  return { whereClauses, params, notes };
}

export async function resolveDimensionValue({ column, value, limit = 5 }) {
  const validColumns = await getValidColumns();
  assertValidColumn(column, validColumns);
  const distinctValues = await fetchDistinct(column);
  return fuzzyCandidates(distinctValues, value, limit);
}

export async function getSchemaEmulation() {
  const rows = await query(`DESCRIBE \`${TABLE}\``);
  return rows.map((row) => ({
    column_name: row.Field,
    column_type: row.Type,
    null: row.Null,
    key: row.Key || null,
  }));
}

// Hard cap on rows returned by an unbounded run_query. emulation_forecast has
// 130k+ rows, so a query like "select * from emulation_forecast" with no LIMIT
// can return a result large enough to blow past the LLM's prompt token budget
// (this is what caused the 'prompt token count ... exceeds the limit' error).
const MAX_QUERY_ROWS = 300;

// Only SELECT is allowed: the LLM generates this query from natural language, and
// the DB account is read-only ("Reader") anyway, but this is a defense-in-depth
// guard against accidental/unsafe statements (no DDL/DML, no stacked statements).
export async function runQuery({ query: sql }) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed) || trimmed.includes(';')) {
    throw new Error('Only a single SELECT statement is allowed.');
  }
  // If the LLM didn't already add its own LIMIT, append a safety one rather
  // than risk returning the entire table.
  const hasLimit = /\blimit\s+\d+/i.test(trimmed);
  const safeSql = hasLimit ? trimmed : `${trimmed} limit ${MAX_QUERY_ROWS}`;
  return query(safeSql);
}

export async function getTableOverview() {
  const [{ rowCount }] = await query(`select count(*) as rowCount from \`${TABLE}\``);
  const [yearRow] = await query(`select min(\`year\`) as min, max(\`year\`) as max from \`${TABLE}\``);
  const [revRow] = await query(
    `select min(\`forecastRevision\`) as min, max(\`forecastRevision\`) as max from \`${TABLE}\``
  );

  const dims = ['ddName', 'orgName', 'projectName', 'siteName', 'tierName', 'categoryName', 'subCategoryName'];
  const distinctCounts = {};
  for (const dim of dims) {
    const [{ count }] = await query(`select count(distinct \`${dim}\`) as count from \`${TABLE}\``);
    distinctCounts[dim] = count;
  }

  return {
    row_count: rowCount,
    year_range: [yearRow.min, yearRow.max],
    forecast_revision_range: [revRow.min, revRow.max],
    distinct_counts: distinctCounts,
  };
}

export async function getDistinctValues({ column, limit = 50 }) {
  const validColumns = await getValidColumns();
  assertValidColumn(column, validColumns);
  const rows = await query(`select distinct \`${column}\` from \`${TABLE}\` order by 1 limit ?`, [limit]);
  return rows.map((row) => row[column]);
}

export async function searchValues({ column, keyword, limit = 20 }) {
  const validColumns = await getValidColumns();
  assertValidColumn(column, validColumns);
  const rows = await query(
    `select distinct \`${column}\` from \`${TABLE}\` where lower(\`${column}\`) like ? limit ?`,
    [`%${keyword.toLowerCase()}%`, limit]
  );
  return rows.map((row) => row[column]);
}

export async function getAllUniqueValues({ columns, limitPerColumn = 200 } = {}) {
  const validColumns = await getValidColumns();
  let targetColumns = validColumns;
  if (columns && columns.length) {
    const invalid = columns.filter((c) => !validColumns.includes(c));
    if (invalid.length) {
      throw new Error(`Invalid column(s): ${invalid.join(', ')}. Valid columns: ${validColumns.join(', ')}`);
    }
    targetColumns = columns;
  }

  const result = {};
  for (const column of targetColumns) {
    const rows = await query(
      `select distinct \`${column}\` from \`${TABLE}\` where \`${column}\` is not null order by 1 limit ?`,
      [limitPerColumn]
    );
    result[column] = rows.map((row) => row[column]);
  }
  return result;
}

export async function getLatestForecast({ projectName, orgName, ddName, year, limit = 100 } = {}) {
  const { whereClauses, params, notes } = await buildNameFilters({ projectName, orgName, ddName });
  if (year) whereClauses.push('`year` = ?');
  if (year) params.push(year);
  const whereSql = whereClauses.length ? `where ${whereClauses.join(' and ')}` : '';

  const rows = await query(
    `
      select * from (
        select t.*,
               max(\`forecastRevision\`) over (partition by \`projectName\`, \`year\`, \`month\`) as \`_maxRevision\`
        from \`${TABLE}\` t
        ${whereSql}
      ) ranked
      where \`forecastRevision\` = \`_maxRevision\`
      limit ?
    `,
    [...params, limit]
  );
  rows.forEach((row) => delete row._maxRevision);
  if (notes.length) rows.forEach((row) => { row._resolution_notes = notes; });
  return rows;
}

export async function getForecastTimeline({ projectName, orgName, ddName, limit = 200 }) {
  const { whereClauses, params, notes } = await buildNameFilters({ projectName, orgName, ddName });
  const whereSql = whereClauses.join(' and ');

  const rows = await query(
    `
      select
        \`year\`, \`month\`, \`tiOffsetMonth\`,
        sum(\`forecastValue\`) as \`totalForecastValue\`,
        count(*) as \`row_count\`
      from \`${TABLE}\`
      where ${whereSql}
      group by \`year\`, \`month\`, \`tiOffsetMonth\`
      order by \`tiOffsetMonth\`
      limit ?
    `,
    [...params, limit]
  );
  if (notes.length && rows.length) rows[0]._resolution_notes = notes;
  return rows;
}

export async function getPreviousForecast({ projectName, year, month, orgName, ddName }) {
  const { whereClauses, params, notes } = await buildNameFilters({ projectName, orgName, ddName });
  const whereSql = whereClauses.join(' and ');

  const currentRows = await query(
    `
      select distinct \`tiOffsetMonth\`
      from \`${TABLE}\`
      where ${whereSql} and \`year\` = ? and \`month\` = ?
    `,
    [...params, year, month]
  );
  if (!currentRows.length) return {};
  const currentOffset = currentRows[0].tiOffsetMonth;

  const rows = await query(
    `
      select
        \`year\`, \`month\`, \`tiOffsetMonth\`,
        sum(\`forecastValue\`) as \`totalForecastValue\`,
        count(*) as \`row_count\`
      from \`${TABLE}\`
      where ${whereSql} and \`tiOffsetMonth\` < ?
      group by \`year\`, \`month\`, \`tiOffsetMonth\`
      order by \`tiOffsetMonth\` desc
      limit 1
    `,
    [...params, currentOffset]
  );
  if (!rows.length) return {};
  const result = rows[0];
  if (notes.length) result._resolution_notes = notes;
  return result;
}

export async function compareForecastToPreviousMonth({ projectName, year, month, orgName, ddName }) {
  const { whereClauses, params, notes } = await buildNameFilters({ projectName, orgName, ddName });
  const whereSql = whereClauses.join(' and ');

  const currentRows = await query(
    `
      select \`year\`, \`month\`, \`tiOffsetMonth\`, sum(\`forecastValue\`) as total, count(*) as cnt
      from \`${TABLE}\`
      where ${whereSql} and \`year\` = ? and \`month\` = ?
      group by \`year\`, \`month\`, \`tiOffsetMonth\`
    `,
    [...params, year, month]
  );
  if (!currentRows.length) return {};
  const current = currentRows[0];

  const previousRows = await query(
    `
      select \`year\`, \`month\`, \`tiOffsetMonth\`, sum(\`forecastValue\`) as total
      from \`${TABLE}\`
      where ${whereSql} and \`tiOffsetMonth\` < ?
      group by \`year\`, \`month\`, \`tiOffsetMonth\`
      order by \`tiOffsetMonth\` desc
      limit 1
    `,
    [...params, current.tiOffsetMonth]
  );

  const result = {
    projectName,
    currentYear: current.year,
    currentMonth: current.month,
    currentForecastValue: current.total,
  };
  if (previousRows.length) {
    const previous = previousRows[0];
    result.previousYear = previous.year;
    result.previousMonth = previous.month;
    result.previousForecastValue = previous.total;
    result.delta = current.total - previous.total;
  } else {
    result.previousYear = null;
    result.previousMonth = null;
    result.previousForecastValue = null;
    result.delta = null;
  }
  if (notes.length) result._resolution_notes = notes;
  return result;
}

export async function getForecastBreakdown({ projectName, year, month, orgName, ddName }) {
  const { whereClauses, params, notes } = await buildNameFilters({ projectName, orgName, ddName });
  whereClauses.push('`year` = ?', '`month` = ?');
  params.push(year, month);
  const whereSql = whereClauses.join(' and ');

  const breakdownDims = [
    'subCategoryName', 'modelSize', 'constraintTypeId',
    'tierName', 'siteName', 'categoryName', 'forecastRevision',
  ];
  const contextDims = ['projectName', 'year', 'month', 'tiOffsetMonth'];
  const selectDims = [...contextDims, ...breakdownDims];
  const dimsSql = selectDims.map((d) => `\`${d}\``).join(', ');

  const rows = await query(
    `select ${dimsSql}, \`forecastValue\` from \`${TABLE}\` where ${whereSql}`,
    params
  );

  if (!rows.length) {
    return {
      projectName, year, month,
      row_count: 0, total_forecast_value: null,
      varying_dimensions: [], rows: [],
      ...(notes.length ? { _resolution_notes: notes } : {}),
    };
  }

  const varyingDimensions = breakdownDims.filter(
    (dim) => new Set(rows.map((row) => row[dim])).size > 1
  );
  const total = rows.reduce((sum, row) => sum + Number(row.forecastValue), 0);

  const result = {
    projectName,
    year,
    month,
    tiOffsetMonth: rows[0].tiOffsetMonth,
    row_count: rows.length,
    total_forecast_value: total,
    varying_dimensions: varyingDimensions,
    rows,
  };
  if (notes.length) result._resolution_notes = notes;
  return result;
}

// OpenAI function-calling tool schemas + dispatcher, mirroring push_db.py's @mcp.tool() set.
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'resolve_dimension_value',
      description:
        'Resolve a possibly partial/misspelled value for a dimension column (ddName, projectName, orgName, subCategoryName, tierName, siteName, categoryName) to the closest real value(s) stored in emulation_forecast. Returns up to `limit` candidates ranked by similarity.',
      parameters: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          value: { type: 'string' },
          limit: { type: 'integer', default: 5 },
        },
        required: ['column', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_schema_enulation',
      description: 'Returns the schema (column_name, column_type, null, key) of the emulation_forecast table.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_query',
      description:
        'Executes a literal SELECT query against emulation_forecast (MySQL/MariaDB syntax) and returns the rows as a list of objects. The table has 130,000+ rows - ALWAYS include a LIMIT clause (e.g. LIMIT 100) unless the query is a pure aggregate (COUNT/SUM/AVG with no SELECT *), otherwise a safety LIMIT is applied automatically and/or the result may be truncated.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_table_overview',
      description:
        'High level overview of emulation_forecast: row count, year range, forecastRevision range, distinct counts of key dimensions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_distinct_values',
      description: 'Returns distinct values present in a given column of emulation_forecast.',
      parameters: {
        type: 'object',
        properties: { column: { type: 'string' }, limit: { type: 'integer', default: 50 } },
        required: ['column'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_values',
      description: 'Case-insensitive partial search for `keyword` inside a VARCHAR column.',
      parameters: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          keyword: { type: 'string' },
          limit: { type: 'integer', default: 20 },
        },
        required: ['column', 'keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_unique_values',
      description: 'Returns distinct values for every column (or the given `columns`) in one call.',
      parameters: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          limitPerColumn: { type: 'integer', default: 200 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_latest_forecast',
      description:
        "Returns forecast rows restricted to the latest forecastRevision per project, optionally filtered by projectName/orgName/ddName/year. Does NOT sum rows for a month - don't rely on limit to pick a month.",
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          orgName: { type: 'string' },
          ddName: { type: 'string' },
          year: { type: 'integer' },
          limit: { type: 'integer', default: 100 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_forecast_timeline',
      description:
        'Full monthly forecast timeline for a project (summed per month), ordered by tiOffsetMonth.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          orgName: { type: 'string' },
          ddName: { type: 'string' },
          limit: { type: 'integer', default: 200 },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_previous_forecast',
      description: 'Forecast for the month immediately before the given year/month in a project timeline.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          year: { type: 'integer' },
          month: { type: 'integer' },
          orgName: { type: 'string' },
          ddName: { type: 'string' },
        },
        required: ['projectName', 'year', 'month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_forecast_to_previous_month',
      description: "Compares a project's forecast for a given year/month against the previous month (delta).",
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          year: { type: 'integer' },
          month: { type: 'integer' },
          orgName: { type: 'string' },
          ddName: { type: 'string' },
        },
        required: ['projectName', 'year', 'month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_forecast_breakdown',
      description:
        "Explains exactly how a project's forecast for a year/month is composed: total, row_count, varying_dimensions, and raw rows. Prefer this for a specific project+year+month question.",
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          year: { type: 'integer' },
          month: { type: 'integer' },
          orgName: { type: 'string' },
          ddName: { type: 'string' },
        },
        required: ['projectName', 'year', 'month'],
      },
    },
  },
];

const TOOL_HANDLERS = {
  resolve_dimension_value: resolveDimensionValue,
  get_schema_enulation: getSchemaEmulation,
  run_query: runQuery,
  get_table_overview: getTableOverview,
  get_distinct_values: getDistinctValues,
  search_values: searchValues,
  get_all_unique_values: getAllUniqueValues,
  get_latest_forecast: getLatestForecast,
  get_forecast_timeline: getForecastTimeline,
  get_previous_forecast: getPreviousForecast,
  compare_forecast_to_previous_month: compareForecastToPreviousMonth,
  get_forecast_breakdown: getForecastBreakdown,
};

// Safety net: all tool schemas in TOOL_DEFINITIONS use camelCase argument names
// (projectName, orgName, ddName, ...), matching the camelCase destructuring in
// each handler above. If the LLM ever emits a snake_case key instead (e.g.
// project_name) - which has happened in practice, likely from prompt wording
// that described params in snake_case - the handler's destructuring would
// silently see `undefined` for that filter instead of erroring, so the filter
// is dropped entirely rather than the call failing loudly. Converting any
// snake_case keys to camelCase here means such a mismatch still behaves
// correctly instead of silently returning unfiltered/wrong results.
function toCamelCase(key) {
  return key.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

function normalizeArgs(args) {
  const normalized = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[toCamelCase(key)] = value;
  }
  return normalized;
}

export async function callTool(name, args = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(normalizeArgs(args));
}
