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

  markAllDead(): void {
    for (const info of this.sessions.values()) info.status = "dead";
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }
}
