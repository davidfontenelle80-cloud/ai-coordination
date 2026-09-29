// d1-db.mjs — adapt a D1Database binding to the hub's db interface.
//
// The hub modules (event-core, auth) speak { queryOne, queryAll, batch }
// with { sql, params } statement objects. In the Worker those run against
// D1; in tests they run against node:sqlite via sqlite-db.mjs.
//
// D1 notes:
// * D1 batch() executes its statements atomically (single transaction).
// * queryOne returns null (not undefined) when no row matches.

export function d1Db(d1) {
  const prep = (stmt) => d1.prepare(stmt.sql).bind(...stmt.params);
  return {
    queryOne: async (sql, params = []) => (await d1.prepare(sql).bind(...params).first()) ?? null,
    queryAll: async (sql, params = []) => (await d1.prepare(sql).bind(...params).all()).results,
    batch: async (stmts) => {
      await d1.batch(stmts.map(prep));
    },
  };
}
