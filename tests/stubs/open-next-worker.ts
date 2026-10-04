// Build-independent placeholder; entrypoint tests provide the adapter mock.
export default {
  fetch(): never { throw new Error("Mock the generated OpenNext adapter in Worker tests"); },
};
export class DOQueueHandler {}
export class DOShardedTagCache {}
export class BucketCachePurge {}
