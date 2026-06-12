export type SessionStatus = "idle" | "running" | "dead";

export interface SessionInfo {
  id: string;
  cwd: string;
  status: SessionStatus;
  lastActivityAt: number; // epoch ms
}

export class SessionRegistry {
  private sessions = new Map<string, SessionInfo>();

  add(id: string, cwd: string): SessionInfo {
    const info: SessionInfo = { id, cwd, status: "idle", lastActivityAt: Date.now() };
    this.sessions.set(id, info);
    return info;
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  setStatus(id: string, status: SessionStatus): void {
    const info = this.sessions.get(id);
    if (!info) return;
    info.status = status;
    info.lastActivityAt = Date.now();
  }

  /**
   * Atomically claim a session for a new prompt (idle → running).
   * The check and the transition must be one synchronous step: two concurrent
   * prompts on the same idle session must not both pass an idle check before
   * either marks it running (KiroConnection holds one subscriber per session,
   * so a double claim loses or misattributes output).
   */
  claim(id: string): "claimed" | "not_found" | "running" | "dead" {
    const info = this.sessions.get(id);
    if (!info) return "not_found";
    if (info.status !== "idle") return info.status;
    info.status = "running";
    info.lastActivityAt = Date.now();
    return "claimed";
  }

  /** running → idle. No-op in any other state (dead stays dead). */
  releaseIfRunning(id: string): void {
    const info = this.sessions.get(id);
    if (info?.status !== "running") return;
    info.status = "idle";
    info.lastActivityAt = Date.now();
  }

  markAllDead(): void {
    for (const info of this.sessions.values()) info.status = "dead";
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }
}
