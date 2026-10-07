import { describe, expect, it, vi, afterEach } from "vitest";
import { webDownloadBinaryExecutor } from "../../src/agent/tools/web/download-binary.js";

describe("audit8: web_download_binary IPv6 / redirect SSRF", () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const url of ["http://[::1]:8080/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://[fd00::1]/a.png", "http://[::ffff:169.254.169.254]/latest/meta-data/x.png"]) {
    it(`issues a request to ${url}`, async () => {
      const fetchSpy = vi.fn(async () => new Response("x", { status: 404, statusText: "NF" }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await webDownloadBinaryExecutor({ url } as any, {} as any);
      console.log(url, JSON.stringify(res));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res.error).toContain("404");
    });
  }
  it("follows redirect to private target before the post-check", async () => {
    const fetchSpy = vi.fn(async (_u: any, init: any) => {
      expect(init.redirect).toBe("follow");
      return new Response("x", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await webDownloadBinaryExecutor({ url: "https://example.com/r.png" } as any, {} as any);
  });
});
