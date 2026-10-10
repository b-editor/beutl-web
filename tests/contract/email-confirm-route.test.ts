import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ approve: vi.fn(), update: vi.fn() }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/email/actions", () => ({
  approveEmailChange: calls.approve,
  updateEmail: calls.update,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
import { GET } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/email/confirm/route";

beforeEach(() => vi.clearAllMocks());
it("dispatches current-mailbox approval before the settings page renders", async () => {
  await GET(
    new Request(
      "https://beutl.beditor.net/en/dashboard/account/email/confirm?approval=1&token=proof&identifier=new%40example.com",
    ),
    { params: Promise.resolve({ lang: "en" }) },
  );
  expect(calls.approve).toHaveBeenCalledWith("proof", "new@example.com");
  expect(calls.update).not.toHaveBeenCalled();
});
it("dispatches new-mailbox confirmation to the protected completion action", async () => {
  await GET(
    new Request(
      "https://beutl.beditor.net/ja/dashboard/account/email/confirm?token=proof&identifier=new%40example.com",
    ),
    { params: Promise.resolve({ lang: "ja" }) },
  );
  expect(calls.update).toHaveBeenCalledWith("proof", "new@example.com");
  expect(calls.approve).not.toHaveBeenCalled();
});
it.each(["token=proof", "identifier=new%40example.com"])(
  "refuses an incomplete link (%s)",
  async (query) => {
    await expect(
      GET(new Request(`https://beutl.beditor.net/en/dashboard/account/email/confirm?${query}`), {
        params: Promise.resolve({ lang: "en" }),
      }),
    ).rejects.toThrow("status=emailUpdateFailed");
    expect(calls.update).not.toHaveBeenCalled();
    expect(calls.approve).not.toHaveBeenCalled();
  },
);
