import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";
import * as relations from "./relations";

const fullSchema = { ...schema, ...relations };

export type Database = ReturnType<typeof createDrizzle>;

function createDrizzle(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1 });
  return drizzle(pool, { schema: fullSchema });
}

export const getDb = () => {
  const { env } = getCloudflareContext({ async: false });

  if (!env.BEUTL_DATABASE_HYPERDRIVE) {
    throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  }

  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
  if (!connectionString) {
    throw new Error("Hyperdrive connection string not available");
  }

  return createDrizzle(connectionString);
};

export const getDbAsync = async () => {
  const { env } = await getCloudflareContext({ async: true });

  if (!env.BEUTL_DATABASE_HYPERDRIVE) {
    throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  }

  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
  if (!connectionString) {
    throw new Error("Hyperdrive connection string not available");
  }

  return createDrizzle(connectionString);
};
