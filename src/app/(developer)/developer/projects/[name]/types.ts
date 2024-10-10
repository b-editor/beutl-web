import type { retrievePackage } from "./actions";

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;
