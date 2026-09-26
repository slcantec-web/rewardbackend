import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { D1Database, D1PreparedStatement, R2Bucket, Env } from "./types";

function sanitizeParam(v: any): any {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function createD1Adapter(dbPath: string): D1Database {
  const db = new DatabaseSync(dbPath);

  class PreparedStatement implements D1PreparedStatement {
    private query: string;
    private params: any[];

    constructor(query: string, params: any[] = []) {
      this.query = query;
      this.params = params;
    }

    bind(...values: any[]): D1PreparedStatement {
      return new PreparedStatement(this.query, values);
    }

    private getSanitized(): any[] {
      return this.params.map(sanitizeParam);
    }

    async first<T = unknown>(colName?: string): Promise<T | null> {
      try {
        const stmt = db.prepare(this.query);
        const row = stmt.get(...this.getSanitized()) as any;
        if (!row) return null;
        if (colName) return (row[colName] ?? null) as T;
        return row as T;
      } catch (err) {
        console.error("D1 first error on:", this.query, this.params, err);
        throw err;
      }
    }

    async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: any }> {
      try {
        const stmt = db.prepare(this.query);
        const results = stmt.all(...this.getSanitized()) as T[];
        return { results, success: true, meta: {} };
      } catch (err) {
        console.error("D1 all error on:", this.query, this.params, err);
        throw err;
      }
    }

    async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
      try {
        const stmt = db.prepare(this.query);
        const res = stmt.run(...this.getSanitized());
        return {
          success: true,
          meta: {
            changes: Number(res.changes),
            last_row_id: Number(res.lastInsertRowid),
          },
        };
      } catch (err) {
        console.error("D1 run error on:", this.query, this.params, err);
        throw err;
      }
    }
  }

  return {
    prepare(query: string): D1PreparedStatement {
      return new PreparedStatement(query);
    },
    async batch(statements: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(query: string) {
      db.exec(query);
    },
  };
}

export function createR2Adapter(): R2Bucket {
  const store = new Map<string, { data: Uint8Array; contentType: string }>();

  return {
    async put(key: string, value: Uint8Array | ArrayBuffer | string, options?: any) {
      let data: Uint8Array;
      if (typeof value === "string") {
        data = new TextEncoder().encode(value);
      } else if (value instanceof Uint8Array) {
        data = value;
      } else {
        data = new Uint8Array(value);
      }
      const contentType = options?.httpMetadata?.contentType || "image/jpeg";
      store.set(key, { data, contentType });
      return { key, size: data.byteLength };
    },

    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        body: item.data,
        httpMetadata: { contentType: item.contentType },
        async arrayBuffer() {
          return item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength);
        },
        async text() {
          return new TextDecoder().decode(item.data);
        },
      };
    },

    async delete(key: string) {
      store.delete(key);
    },
  };
}

let cachedEnv: Env | null = null;

export function initializeDatabaseAndEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const dbFilePath = path.resolve(process.cwd(), "reward-system.db");
  const isFresh = !fs.existsSync(dbFilePath);

  const db = createD1Adapter(dbFilePath);
  const r2 = createR2Adapter();

  if (isFresh) {
    console.log("Initializing database schema from schema.sql...");
    const schemaSqlPath = path.resolve(process.cwd(), "schema.sql");
    if (fs.existsSync(schemaSqlPath)) {
      const schemaSql = fs.readFileSync(schemaSqlPath, "utf-8");
      db.exec?.(schemaSql);
    }
  }

  // Ensure default staff accounts are present
  // admin / admin123 (role: admin)
  // admin1 / admin123 (role: admin)
  // finance / finance123 (role: finance_staff)
  // lead / lead123 (role: finance_lead)
  const defaultStaff = [
    { username: "admin", hash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9", role: "admin" },
    { username: "admin1", hash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9", role: "admin" },
    { username: "finance", hash: "48f7312924d74358e75294e3b3613f2319d99e944184b69550f528577ca082fb", role: "finance_staff" },
    { username: "lead", hash: "5830aa9ba1fd7843c92fd956cb640604e6d3bff683ddeeac778e0af21089a303", role: "finance_lead" },
  ];

  for (const s of defaultStaff) {
    db.exec?.(
      `INSERT OR IGNORE INTO staff_users (username, password_hash, role, active) VALUES ('${s.username}', '${s.hash}', '${s.role}', 1)`
    );
  }

  cachedEnv = {
    DB: db,
    BILL_IMAGES: r2,
    GEOFENCE_RADIUS_KM: process.env.GEOFENCE_RADIUS_KM || "5",
    VELOCITY_MAX_SUBMISSIONS: process.env.VELOCITY_MAX_SUBMISSIONS || "3",
    VELOCITY_WINDOW_MINUTES: process.env.VELOCITY_WINDOW_MINUTES || "10",
    IP_VELOCITY_MAX_SUBMISSIONS: process.env.IP_VELOCITY_MAX_SUBMISSIONS || "5",
    IP_VELOCITY_WINDOW_MINUTES: process.env.IP_VELOCITY_WINDOW_MINUTES || "10",
    WALLET_PAYOUT_THRESHOLD_LKR: process.env.WALLET_PAYOUT_THRESHOLD_LKR || "1000",
    FINANCE_JWT_SECRET: process.env.FINANCE_JWT_SECRET || "finance-jwt-secret-key-cantec-secure-32-chars",
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || "admin-jwt-secret-key-cantec-secure-32-chars",
  };

  return cachedEnv;
}
