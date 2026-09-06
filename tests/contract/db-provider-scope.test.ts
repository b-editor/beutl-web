import { describe, expect, it, vi } from "vitest";
import {
  getDb,
  hasDbProviderScope,
  setDbProvider,
  trackDbProviderScopeTask,
  type PrismaClient,
} from "../../packages/db/src/provider";
import {
  runWithDbProviderResponseScope,
  runWithDbProviderScope,
  runWithConfiguredDbProviderResponseScope,
} from "../../packages/db/src/provider-scope";

type FakeClient = PrismaClient & {
  id: string;
  $disconnect: ReturnType<typeof vi.fn>;
};

function createClient(id: string, disconnectError?: Error): FakeClient {
  return {
    id,
    $disconnect: vi.fn(async () => {
      if (disconnectError) throw disconnectError;
    }),
  } as unknown as FakeClient;
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals++;
    if (arrivals === 2) release();
    await released;
  };
}

describe("request-scoped database provider", () => {
  it("isolates concurrent scopes and creates and disconnects once per scope", async () => {
    const clientA = createClient("a");
    const clientB = createClient("b");
    const factoryA = vi.fn(async () => clientA);
    const factoryB = vi.fn(async () => clientB);
    const barrier = twoPartyBarrier();

    const runScope = (
      factory: () => Promise<PrismaClient>,
    ) => runWithDbProviderScope(factory, async () => {
      const [first, second] = await Promise.all([getDb(), getDb()]);
      await barrier();
      expect(await getDb()).toBe(first);
      return [first, second] as const;
    });

    const [[a1, a2], [b1, b2]] = await Promise.all([
      runScope(factoryA),
      runScope(factoryB),
    ]);

    expect(a1).toBe(clientA);
    expect(a2).toBe(clientA);
    expect(b1).toBe(clientB);
    expect(b2).toBe(clientB);
    expect(a1).not.toBe(b1);
    expect(factoryA).toHaveBeenCalledOnce();
    expect(factoryB).toHaveBeenCalledOnce();
    expect(clientA.$disconnect).toHaveBeenCalledOnce();
    expect(clientB.$disconnect).toHaveBeenCalledOnce();
  });

  it("shares one rejected factory call without creating a cleanup rejection", async () => {
    const factoryError = new Error("factory failed");
    const factory = vi.fn(async (): Promise<PrismaClient> => {
      throw factoryError;
    });

    const result = await runWithDbProviderScope(factory, async () => {
      const attempts = await Promise.allSettled([getDb(), getDb()]);
      expect(attempts).toEqual([
        { status: "rejected", reason: factoryError },
        { status: "rejected", reason: factoryError },
      ]);
      return "handled";
    });

    expect(result).toBe("handled");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("reports a disconnect failure without replacing a successful result", async () => {
    const cleanupError = new Error("disconnect failed");
    const client = createClient("cleanup-error", cleanupError);
    const onCleanupError = vi.fn();

    const result = await runWithDbProviderScope(
      async () => client,
      async () => {
        expect(await getDb()).toBe(client);
        return "response";
      },
      onCleanupError,
    );

    expect(result).toBe("response");
    expect(client.$disconnect).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
  });

  it("keeps the scope open until a registered streaming producer finishes", async () => {
    const client = createClient("stream");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = await runWithDbProviderResponseScope(
      async () => client,
      async (waitUntil) => {
        const producer = (async () => {
          await released;
          expect(await getDb()).toBe(client);
        })();
        waitUntil(producer);
        return new Response(
          new ReadableStream({
            start(controller) {
              void producer.then(() => {
                controller.enqueue(new TextEncoder().encode("complete"));
                controller.close();
              });
            },
          }),
        );
      },
    );

    expect(client.$disconnect).not.toHaveBeenCalled();
    release();
    await expect(response.text()).resolves.toBe("complete");
    expect(client.$disconnect).toHaveBeenCalledOnce();
  });

  it("waits for an adopted producer after the response is cancelled", async () => {
    const client = createClient("cancelled-stream");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let producer: Promise<void> | undefined;

    const response = await runWithDbProviderResponseScope(
      async () => client,
      async () => {
        producer = (async () => {
          await released;
          expect(await getDb()).toBe(client);
        })();
        trackDbProviderScopeTask(producer);
        return new Response(new ReadableStream({ start() {} }));
      },
    );

    const cancellation = response.body!.cancel();
    expect(client.$disconnect).not.toHaveBeenCalled();
    release();
    await producer;
    await cancellation;
    await vi.waitFor(() => expect(client.$disconnect).toHaveBeenCalledOnce());
  });

  it("adopts a child task scheduled while draining its parent", async () => {
    const client = createClient("child-task");
    let releaseParent!: () => void;
    const parentReleased = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseChild!: () => void;
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    await runWithDbProviderResponseScope(
      async () => client,
      async (waitUntil) => {
        await getDb();
        waitUntil((async () => {
          await parentReleased;
          waitUntil((async () => {
            await childReleased;
            expect(await getDb()).toBe(client);
          })());
        })());
        return Response.json({ accepted: true });
      },
    );

    expect(client.$disconnect).not.toHaveBeenCalled();
    releaseParent();
    await Promise.resolve();
    expect(client.$disconnect).not.toHaveBeenCalled();
    releaseChild();
    await vi.waitFor(() => expect(client.$disconnect).toHaveBeenCalledOnce());
  });

  it("resolves the configured provider lazily inside the outer request scope", async () => {
    const client = createClient("configured");
    const factory = vi.fn(async () => client);

    const response = await runWithConfiguredDbProviderResponseScope(
      async () => {
        expect(hasDbProviderScope()).toBe(true);
        setDbProvider(factory);
        const clients = await Promise.all([getDb(), getDb()]);
        return Response.json(clients.map((item) => (item as FakeClient).id));
      },
    );
    const result = await response.json();

    expect(result).toEqual(["configured", "configured"]);
    expect(factory).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(client.$disconnect).toHaveBeenCalledOnce());
    expect(hasDbProviderScope()).toBe(false);
  });
});
