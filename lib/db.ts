import { Pool, type PoolClient } from "pg"
import { Signer } from "@aws-sdk/rds-signer"
import { awsCredentialsProvider } from "@vercel/functions/oidc"
import { attachDatabasePool } from "@vercel/functions"

const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN
const AWS_REGION = process.env.AWS_REGION || "us-east-1"
const PGHOST = process.env.PGHOST!
const PGUSER = process.env.PGUSER || "postgres"
const PGDATABASE = process.env.PGDATABASE || "postgres"
const PGPORT = Number(process.env.PGPORT) || 5432

// Only create the IAM signer when a role ARN is available (i.e. Preview/Production).
// In development without a role ARN we rely on PGPASSWORD if set.
const signer = AWS_ROLE_ARN
  ? new Signer({
      credentials: awsCredentialsProvider({
        roleArn: AWS_ROLE_ARN,
        clientConfig: { region: AWS_REGION },
      }),
      region: AWS_REGION,
      hostname: PGHOST,
      username: PGUSER,
      port: PGPORT,
    })
  : null

declare global {
  // eslint-disable-next-line no-var
  var __forecastHubPool: Pool | undefined
}

function createPool() {
  const pool = new Pool({
    host: PGHOST,
    database: PGDATABASE,
    port: PGPORT,
    user: PGUSER,
    // Use IAM token when signer is available, otherwise fall back to PGPASSWORD env var.
    password: signer ? () => signer.getAuthToken() : (process.env.PGPASSWORD ?? undefined),
    ssl: { rejectUnauthorized: false },
    max: 20,
  })
  attachDatabasePool(pool)
  return pool
}

export const pool = global.__forecastHubPool ?? createPool()
if (process.env.NODE_ENV !== "production") global.__forecastHubPool = pool

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await pool.query(text, params)
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
}

// Run a function inside a SERIALIZABLE transaction. Used for all money movement.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  isolation: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED" = "SERIALIZABLE",
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
