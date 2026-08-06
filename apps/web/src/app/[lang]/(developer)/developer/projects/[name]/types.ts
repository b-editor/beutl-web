import type { retrievePackage } from "./actions/package";

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;
