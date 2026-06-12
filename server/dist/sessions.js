export class SessionRegistry {
    sessions = new Map();
    add(id, cwd) {
        const info = { id, cwd, status: "idle", lastActivityAt: Date.now() };
        this.sessions.set(id, info);
        return info;
    }
    get(id) {
        return this.sessions.get(id);
    }
    setStatus(id, status) {
        const info = this.sessions.get(id);
        if (!info)
            return;
        info.status = status;
        info.lastActivityAt = Date.now();
    }
    markAllDead() {
        for (const info of this.sessions.values())
            info.status = "dead";
    }
    list() {
        return [...this.sessions.values()];
    }
}
