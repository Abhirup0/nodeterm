import { EventEmitter } from "events";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionHostPaths } from "../session-host/paths";
import {
  SESSION_HOST_PROTOCOL_VERSION,
  LineFramer,
  encodeFrame,
  type SessionHostRequest,
} from "../session-host/protocol";

const launcherMocks = vi.hoisted(() => ({
  resolveSessionHostScript: vi.fn(),
  spawnSessionHost: vi.fn(),
}));

const identityMocks = vi.hoisted(() => ({
  readExistingSessionHostIdentity: vi.fn(),
}));

vi.mock("./session-host-launcher", () => launcherMocks);
vi.mock("../session-host/existing-host-state", () => identityMocks);

import { SessionHostClient } from "./session-host-client";

const openServers = new Set<net.Server>();
const openSockets = new Set<net.Socket>();
const tempDirs = new Set<string>();

type WriteCallback = (error?: Error | null) => void;
type FakeWriteHandler = (
  request: SessionHostRequest,
  callback?: WriteCallback,
) => void;

class FakeSocket extends EventEmitter {
  destroyed = false;

  constructor(private readonly onWrite: FakeWriteHandler) {
    super();
  }

  begin(): void {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit("connect");
    });
  }

  unref(): this {
    return this;
  }

  write(chunk: string | Uint8Array, ...args: unknown[]): boolean {
    const callback = args.find(
      (arg): arg is WriteCallback => typeof arg === "function",
    );
    for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
      if (line.trim())
        this.onWrite(JSON.parse(line) as SessionHostRequest, callback);
    }
    return true;
  }

  respond(frame: Parameters<typeof encodeFrame>[0]): void {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit("data", Buffer.from(encodeFrame(frame)));
    });
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function useFakeConnections(
  ...sockets: FakeSocket[]
): ReturnType<typeof vi.spyOn> {
  let index = 0;
  const spy = vi.spyOn(net, "connect").mockImplementation(((
    ..._args: unknown[]
  ) => {
    const socket = sockets[index++];
    if (!socket) throw new Error("unexpected extra session-host connection");
    socket.begin();
    return socket as unknown as net.Socket;
  }) as typeof net.connect);
  return spy;
}

function within<T>(promise: Promise<T>, ms = 750): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`session-host transport did not answer within ${ms}ms`),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nodeterm-session-transport-"),
  );
  tempDirs.add(dir);
  return dir;
}

function readyIdentity(userDataDir: string, token = "a".repeat(64)) {
  const paths = sessionHostPaths(userDataDir);
  return {
    kind: "ready" as const,
    state: {
      pid: 42,
      endpoint: paths.endpoint,
      tokenPath: paths.tokenPath,
      startedAt: 1,
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    },
    token,
  };
}

function spawnOptions(userDataDir: string) {
  return {
    cwd: userDataDir,
    shell: process.execPath,
    args: [],
    env: {},
    cols: 80,
    rows: 24,
  };
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
}

function successSocket(
  onRequest: (
    request: SessionHostRequest,
    socket: FakeSocket,
    callback?: WriteCallback,
  ) => void,
): FakeSocket {
  let socket!: FakeSocket;
  socket = new FakeSocket((request, callback) => {
    if (request.cmd === "hello") {
      callback?.();
      // `readyIdentity()` (the identity every caller of this helper publishes) defaults to
      // SESSION_HOST_PROTOCOL_VERSION, and the client refuses a state file that disagrees with
      // what hello actually negotiates ("session-host protocol publication disagrees with
      // hello"). Advertising it here — not omitting it, which negotiates legacy v1 — is what
      // keeps this fake host internally consistent with the identity these tests publish.
      socket.respond({
        id: request.id,
        ok: true,
        result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION },
      });
      return;
    }
    onRequest(request, socket, callback);
  });
  return socket;
}

beforeEach(() => {
  launcherMocks.resolveSessionHostScript.mockReset();
  launcherMocks.resolveSessionHostScript.mockReturnValue(null);
  launcherMocks.spawnSessionHost.mockReset();
  identityMocks.readExistingSessionHostIdentity.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  openServers.clear();
  for (const dir of tempDirs) {
    const endpoint = sessionHostPaths(dir).endpoint;
    if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  tempDirs.clear();
});

describe("SessionHostClient transport boundaries", () => {
  it("accepts only the response correlated to its hello request", async () => {
    const userDataDir = makeTempDir();
    const paths = sessionHostPaths(userDataDir);
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir),
    );
    let attachRequests = 0;

    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.once("close", () => openSockets.delete(socket));
      const framer = new LineFramer();
      socket.on("data", (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(
          chunk.toString("utf8"),
        )) {
          if (request.cmd === "hello") {
            socket.write(
              encodeFrame({ id: request.id + 10_000, ok: true }) +
                encodeFrame({
                  id: request.id,
                  ok: false,
                  error: "token refused",
                }),
            );
          } else if (request.cmd === "attach") {
            attachRequests++;
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { fresh: true },
              }),
            );
          }
        }
      });
    });
    await listen(server, paths.endpoint);

    const client = new SessionHostClient({ userDataDir });
    const subscriber = { onData: vi.fn(), onExit: vi.fn() };
    await expect(
      within(
        client.attach(
          "nt-wrong-hello",
          spawnOptions(userDataDir),
          1_000,
          subscriber,
        ),
      ),
    ).rejects.toThrow();
    expect(attachRequests).toBe(0);
    expect(subscriber.onData).not.toHaveBeenCalled();
  });

  it("treats only a missing token as permission to launch and retry", async () => {
    const userDataDir = makeTempDir();
    const paths = sessionHostPaths(userDataDir);
    identityMocks.readExistingSessionHostIdentity
      .mockReturnValueOnce({ kind: "absent", missing: "state" })
      .mockReturnValue(readyIdentity(userDataDir, "b".repeat(64)));
    launcherMocks.resolveSessionHostScript.mockReturnValue(
      "fake-session-host.cjs",
    );

    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.once("close", () => openSockets.delete(socket));
      const framer = new LineFramer();
      socket.on("data", (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(
          chunk.toString("utf8"),
        )) {
          if (request.cmd === "hello") {
            expect(request.token).toBe("b".repeat(64));
            // `readyIdentity()` publishes SESSION_HOST_PROTOCOL_VERSION; the hello answer must
            // advertise the same version or the client refuses it as an inconsistent host.
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION },
              }),
            );
          } else if (request.cmd === "listSessions") {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { names: ["nt-launched"] },
              }),
            );
          }
        }
      });
    });
    await listen(server, paths.endpoint);

    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions(), 1_500)).resolves.toEqual([
      "nt-launched",
    ]);
    expect(launcherMocks.spawnSessionHost).toHaveBeenCalledTimes(1);
  });

  it.each(["EISDIR", "EACCES", "EIO"])(
    "propagates a %s token read failure without invoking the launcher",
    async (code) => {
      const userDataDir = makeTempDir();
      launcherMocks.resolveSessionHostScript.mockReturnValue(
        "fake-session-host.cjs",
      );
      launcherMocks.spawnSessionHost.mockImplementation(() => {
        throw new Error("launcher must not run after a token read failure");
      });
      const error = Object.assign(
        new Error(`synthetic ${code} token failure`),
        { code },
      );
      identityMocks.readExistingSessionHostIdentity.mockImplementation(() => {
        throw error;
      });

      const client = new SessionHostClient({ userDataDir });
      await expect(within(client.listSessions())).rejects.toMatchObject({
        code,
      });
      expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty token without invoking the launcher", async () => {
    const userDataDir = makeTempDir();
    launcherMocks.resolveSessionHostScript.mockReturnValue(
      "fake-session-host.cjs",
    );
    launcherMocks.spawnSessionHost.mockImplementation(() => {
      throw new Error("launcher must not run for an empty token");
    });
    identityMocks.readExistingSessionHostIdentity.mockImplementation(() => {
      throw new Error("invalid session-host token: file is empty");
    });

    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions())).rejects.toThrow(
      /token: file is empty/i,
    );
    expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled();
  });

  // `1` is NOT the incompatible case: session-host-client.ts keeps protocol-v1 hosts connectable
  // on purpose, for warm terminal continuity across an app upgrade — only a specific v2-only
  // OPERATION (one that needs atomic generation semantics) refuses a v1 host, with
  // SessionHostProtocolCompatibilityError, and that refusal happens after a successful connect
  // (see session-host-client.test.ts, which documents and exercises exactly that split). The
  // pre-connect guard this test is actually about fires only for a state.protocolVersion that is
  // neither 1 nor SESSION_HOST_PROTOCOL_VERSION — a host from neither a supported legacy nor the
  // current release.
  it("rejects a host publishing an unsupported protocol version without connecting or launching", async () => {
    const userDataDir = makeTempDir();
    const identity = readyIdentity(userDataDir);
    const unsupportedVersion = 3;
    identityMocks.readExistingSessionHostIdentity.mockReturnValue({
      ...identity,
      state: { ...identity.state, protocolVersion: unsupportedVersion },
    });
    launcherMocks.resolveSessionHostScript.mockReturnValue(
      "fake-session-host.cjs",
    );
    const connectSpy = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("an incompatible host must not be contacted");
    });

    expect(SESSION_HOST_PROTOCOL_VERSION).toBe(2);
    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions())).rejects.toThrow(
      `incompatible session-host protocol: host=${unsupportedVersion}, client=2`,
    );
    expect(connectSpy).not.toHaveBeenCalled();
    expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled();
  });

  it("rejects a 64-character non-hex token without connecting or launching", async () => {
    const userDataDir = makeTempDir();
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir, "g".repeat(64)),
    );
    launcherMocks.resolveSessionHostScript.mockReturnValue(
      "fake-session-host.cjs",
    );
    const connectSpy = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("a malformed token must not reach the socket");
    });

    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions())).rejects.toThrow(
      "invalid session-host token: expected 64 hexadecimal characters",
    );
    expect(connectSpy).not.toHaveBeenCalled();
    expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled();
  });

  it("rejects an async write failure promptly and reconnects the next request", async () => {
    const userDataDir = makeTempDir();
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir, "c".repeat(64)),
    );
    const writeError = new Error("asynchronous socket write exploded");
    const first = successSocket((request, _socket, callback) => {
      expect(request.cmd).toBe("listSessions");
      queueMicrotask(() => callback?.(writeError));
    });
    const second = successSocket((request, socket, callback) => {
      expect(request.cmd).toBe("listSessions");
      callback?.();
      socket.respond({
        id: request.id,
        ok: true,
        result: { names: ["nt-reconnected"] },
      });
    });
    const connectSpy = useFakeConnections(first, second);

    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions())).rejects.toThrow(
      writeError.message,
    );
    await expect(within(client.listSessions())).resolves.toEqual([
      "nt-reconnected",
    ]);
    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores a late write callback error after that exact request already resolved", async () => {
    const userDataDir = makeTempDir();
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir, "d".repeat(64)),
    );
    let listRequest = 0;
    let lateFirstCallback: WriteCallback | undefined;
    let secondRequest: SessionHostRequest | undefined;
    const socket = successSocket((request, ownSocket, callback) => {
      expect(request.cmd).toBe("listSessions");
      listRequest++;
      if (listRequest === 1) {
        lateFirstCallback = callback;
        ownSocket.respond({
          id: request.id,
          ok: true,
          result: { names: ["first"] },
        });
      } else {
        secondRequest = request;
      }
    });
    const connectSpy = useFakeConnections(socket);
    const client = new SessionHostClient({ userDataDir });

    await expect(within(client.listSessions())).resolves.toEqual(["first"]);
    const second = client.listSessions();
    await expect.poll(() => secondRequest).toBeDefined();
    lateFirstCallback?.(new Error("late error for the completed write"));
    await Promise.resolve();
    socket.respond({
      id: secondRequest!.id,
      ok: true,
      result: { names: ["second"] },
    });

    await expect(within(second)).resolves.toEqual(["second"]);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it("closes the uncertain socket and rejects a request whose deadline expires", async () => {
    const userDataDir = makeTempDir();
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir, "e".repeat(64)),
    );
    const socket = successSocket((request, ownSocket, callback) => {
      if (request.cmd === "hasSession") {
        callback?.();
        ownSocket.respond({
          id: request.id,
          ok: true,
          // A v2 host names the generation of a live session; the client records it so the
          // following attachExisting can assert it (ABA protection on the warm-reattach path).
          result: { exists: true, generation: 'prewarm-generation' },
        });
      }
      // listSessions deliberately receives neither a write error nor a response.
    });
    useFakeConnections(socket);
    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.hasSession("nt-prewarm"))).resolves.toBe(true);

    vi.useFakeTimers();
    const ignored = client.listSessions();
    const rejection = expect(ignored).rejects.toThrow(/timed out|deadline/i);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await rejection;
    expect(socket.destroyed).toBe(true);
  });

  it("propagates listSessions protocol failures as unavailable instead of an empty list", async () => {
    const userDataDir = makeTempDir();
    identityMocks.readExistingSessionHostIdentity.mockReturnValue(
      readyIdentity(userDataDir, "f".repeat(64)),
    );
    const socket = successSocket((request, ownSocket, callback) => {
      expect(request.cmd).toBe("listSessions");
      callback?.();
      ownSocket.respond({
        id: request.id,
        ok: false,
        error: "session inventory unavailable",
      });
    });
    useFakeConnections(socket);

    const client = new SessionHostClient({ userDataDir });
    await expect(within(client.listSessions())).rejects.toThrow(
      "session inventory unavailable",
    );
  });
});
