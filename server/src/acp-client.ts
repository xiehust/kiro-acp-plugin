import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Writable as NodeWritable, Readable as NodeReadable } from "node:stream";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface KiroSpawnOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type UpdateHandler = (params: SessionNotification) => void;

type SpawnedChild = ChildProcessByStdio<NodeWritable, NodeReadable, null>;

export class KiroConnection {
  private child: SpawnedChild | undefined;
  private conn: ClientSideConnection | undefined;
  private starting: Promise<void> | undefined;
  private subscribers = new Map<string, UpdateHandler>();

  /** Fired whenever the kiro process exits, for any reason. */
  onExit: (() => void) | undefined;

  constructor(private opts: KiroSpawnOptions) {}

  get launchArgs(): readonly string[] {
    return this.opts.args;
  }

  /** Add CLI flags (e.g. --model). Returns false if the process already started. */
  addLaunchArgs(flags: string[]): boolean {
    if (this.child !== undefined) return false;
    this.opts.args = [...this.opts.args, ...flags];
    return true;
  }

  isAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  subscribe(sessionId: string, handler: UpdateHandler): () => void {
    this.subscribers.set(sessionId, handler);
    return () => this.subscribers.delete(sessionId);
  }

  async ensureStarted(): Promise<void> {
    if (this.isAlive()) return;
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const child = spawn(this.opts.bin, this.opts.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: this.opts.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (err) =>
        reject(
          new Error(
            `failed to start ${this.opts.bin}: ${err.message}. ` +
              `Is kiro-cli installed and on PATH? (set KIRO_MCP_BIN to override)`,
          ),
        ),
      );
    });
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.conn = undefined;
      }
      this.onExit?.();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const subscribers = this.subscribers;
    const client: Client = {
      async sessionUpdate(params) {
        subscribers.get(params.sessionId)?.(params);
      },
      async requestPermission() {
        // --trust-all-tools means kiro should never ask; refuse defensively.
        return { outcome: { outcome: "cancelled" } };
      },
    };
    this.conn = new ClientSideConnection(() => client, stream);
    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  async newSession(cwd: string): Promise<string> {
    await this.ensureStarted();
    const resp = await this.conn!.newSession({ cwd, mcpServers: [] });
    return resp.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    if (!this.conn) throw new Error("kiro-cli is not running — call ensureStarted first");
    return await this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    await this.conn.cancel({ sessionId });
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
    this.conn = undefined;
  }
}
