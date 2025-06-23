import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from './drizzle/schema';

export async function drizzle() {
  const connectionString = (await getCloudflareContext({ async: true })).env.BEUTL_DATABASE_HYPERDRIVE.connectionString || process.env.DATABASE_URL;

  const pool = new Pool({
    connectionString
  });

  return drizzlePg({ schema, client: pool });
}
