import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hostedGit: vi.fn(),
  ownsActiveGitRepository: vi.fn(),
  readRepositoryFile: vi.fn(),
}));

vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/git-repositories", () => ({
  GitRepositoryError: class GitRepositoryError extends Error {},
  hostedGit: mocks.hostedGit,
}));
vi.mock("@beutl/api/git/repositories", () => ({ ownsActiveGitRepository: mocks.ownsActiveGitRepository }));
vi.mock("@beutl/api/git/repository-browser", () => ({ readRepositoryFile: mocks.readRepositoryFile }));

type ContentGet = typeof import("../../apps/web/src/app/api/repositories/[repositoryId]/content/route").GET;
let GET: ContentGet;

beforeAll(async () => {
  ({ GET } = await import("../../apps/web/src/app/api/repositories/[repositoryId]/content/route"));
});

const repositoryId = "12345678-1234-1234-1234-123456789abc";

async function request(query: string, repository = repositoryId, headers?: HeadersInit) {
  return await GET(
    new Request(`http://localhost/api/repositories/${repository}/content?${query}`, { headers }) as Parameters<ContentGet>[0],
    { params: Promise.resolve({ repositoryId: repository }) },
  );
}

function file(name: string, response: Response) {
  return { entry: { name, path: `assets/${name}`, type: "blob", oid: "b".repeat(40), size: 5 }, response };
}

describe("repository content route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    mocks.hostedGit.mockResolvedValue({ env: { BEUTL_GIT_ENABLED: "true" }, origin: "https://beutl.test" });
    mocks.ownsActiveGitRepository.mockResolvedValue(true);
  });

  it.each([
    ["anyone signed out", () => mocks.getSession.mockResolvedValue(null)],
    ["another account", () => mocks.ownsActiveGitRepository.mockResolvedValue(false)],
    ["a path that is not in the commit", () => mocks.readRepositoryFile.mockResolvedValue(null)],
  ])("answers %s with the same private 404", async (_case, arrange) => {
    arrange();
    const response = await request("ref=main&path=assets/clip.mp4");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["ref=main&path=", repositoryId],
    ["ref=main&path=../secret", repositoryId],
    ["ref=main&path=assets//clip.mp4", repositoryId],
    ["ref=a..b&path=clip.mp4", repositoryId],
    ["ref=main&path=clip.mp4", "not-a-repository"],
  ])("refuses %s before reading anything", async (query, repository) => {
    const response = await request(query, repository);
    expect(response.status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readRepositoryFile).not.toHaveBeenCalled();
  });

  it("streams media inline with the range storage answered, for the owner only", async () => {
    mocks.readRepositoryFile.mockResolvedValue(file("clip.mp4", new Response("media", { status: 206, headers: {
      "Content-Length": "5", "Content-Range": "bytes 0-4/100", "Accept-Ranges": "bytes", "Content-Type": "binary/octet-stream",
    } })));
    const response = await request("ref=main&path=assets/clip.mp4", repositoryId, { Range: "bytes=0-4" });

    expect(mocks.readRepositoryFile).toHaveBeenCalledWith(
      { BEUTL_GIT_ENABLED: "true" }, { repoId: repositoryId, ownerId: "owner", scope: "read" },
      expect.any(Request), "main", "assets/clip.mp4",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Disposition")).toBe("inline; filename=\"clip.mp4\"; filename*=UTF-8''clip.mp4");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-4/100");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("media");
  });

  it("sends anything a browser should not render as an inert download", async () => {
    mocks.readRepositoryFile.mockResolvedValue(file("Project.bep", new Response("{}", { headers: { "Content-Length": "2" } })));
    const response = await request("ref=main&path=assets/Project.bep");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="Project.bep"/u);
  });
});
