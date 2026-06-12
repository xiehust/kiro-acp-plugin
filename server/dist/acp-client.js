import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, } from "@agentclientprotocol/sdk";
/** Thrown when the kiro child process exits while a request is in flight. */
export class KiroExitError extends Error {
}
export class KiroConnection {
    opts;
    child;
    conn;
    starting;
    exitPromise;
    subscribers = new Map();
    /** Fired whenever the kiro process exits, for any reason. */
    onExit;
    constructor(opts) {
        this.opts = opts;
    }
    get launchArgs() {
        return this.opts.args;
    }
    /** Add CLI flags (e.g. --model). Returns false if the process already started. */
    addLaunchArgs(flags) {
        if (this.child !== undefined)
            return false;
        this.opts.args = [...this.opts.args, ...flags];
        return true;
    }
    isAlive() {
        return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
    }
    subscribe(sessionId, handler) {
        this.subscribers.set(sessionId, handler);
        return () => this.subscribers.delete(sessionId);
    }
    async ensureStarted() {
        if (this.starting)
            return this.starting;
        if (this.isAlive())
            return;
        this.starting = this.doStart().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }
    async doStart() {
        const child = spawn(this.opts.bin, this.opts.args, {
            stdio: ["pipe", "pipe", "inherit"],
            env: this.opts.env,
        });
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", (err) => reject(new Error(`failed to start ${this.opts.bin}: ${err.message}. ` +
                `Is kiro-cli installed and on PATH? (set KIRO_MCP_BIN to override)`)));
        });
        this.child = child;
        this.exitPromise = new Promise((_, reject) => {
            child.once("exit", (code, signal) => {
                if (this.child === child) {
                    this.child = undefined;
                    this.conn = undefined;
                }
                this.onExit?.();
                reject(new KiroExitError(`kiro-cli exited unexpectedly (code=${code} signal=${signal})`));
            });
        });
        // avoid unhandled-rejection noise when no request is in flight
        this.exitPromise.catch(() => { });
        const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
        const subscribers = this.subscribers;
        const client = {
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
    async newSession(cwd) {
        await this.ensureStarted();
        const resp = await this.conn.newSession({ cwd, mcpServers: [] });
        return resp.sessionId;
    }
    async prompt(sessionId, text) {
        if (!this.conn || !this.exitPromise) {
            throw new Error("kiro-cli is not running — call ensureStarted first");
        }
        const exitPromise = this.exitPromise;
        try {
            return await Promise.race([
                this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
                exitPromise,
            ]);
        }
        catch (err) {
            // The SDK rejects in-flight requests with "ACP connection closed" when the
            // stdout pipe closes, typically ~0.1-0.3ms BEFORE the OS "exit" event. Give
            // the exit promise a short grace window to supersede that error with the
            // richer KiroExitError. 50ms is a heuristic, not a guarantee: a child that
            // closes stdout then lingers (>50ms) before exiting will surface the raw
            // SDK error instead, and isAlive() may still be true at that instant —
            // callers classifying crashes should check `err instanceof KiroExitError
            // || !isAlive()` and treat the registry as eventually consistent (onExit
            // still fires when the real exit lands).
            const yieldToEventLoop = new Promise((r) => setTimeout(() => r(null), 50));
            const exitError = await Promise.race([
                exitPromise,
                yieldToEventLoop,
            ]).catch((e) => e);
            if (exitError instanceof KiroExitError) {
                throw exitError;
            }
            throw err;
        }
    }
    async cancel(sessionId) {
        if (!this.conn)
            return;
        await this.conn.cancel({ sessionId });
    }
    async stop() {
        this.child?.kill();
        this.child = undefined;
        this.conn = undefined;
        this.exitPromise = undefined;
        this.starting = undefined;
    }
}
