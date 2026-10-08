import { expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { TonProxyManager } from "../manager.js";
it("does not signal an unrelated process when the proxy port is occupied (#759)", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const kill = vi.spyOn(process, "kill");
  try {
    const manager = new TonProxyManager({
      enabled: true,
      port,
      binary_path: "/missing/proxy",
    } as never);
    await expect(manager.start()).rejects.toThrow(/in use/);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
