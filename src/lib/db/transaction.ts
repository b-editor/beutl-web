import { drizzle } from "@/drizzle";


type Database = Awaited<ReturnType<typeof drizzle>>;
export type Transaction = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
