import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../src/sessions.js";

describe("SessionRegistry", () => {
  it("adds a session as idle and retrieves it", () => {
    const reg = new SessionRegistry();
    const info = reg.add("sess_1", "/tmp/proj");
    expect(info).toMatchObject({ id: "sess_1", cwd: "/tmp/proj", status: "idle" });
    expect(reg.get("sess_1")).toBe(info);
  });

  it("returns undefined for unknown ids", () => {
    expect(new SessionRegistry().get("nope")).toBeUndefined();
  });

  it("setStatus updates status and bumps lastActivityAt", () => {
    const reg = new SessionRegistry();
    const info = reg.add("sess_1", "/tmp");
    const before = info.lastActivityAt;
    reg.setStatus("sess_1", "running");
    expect(info.status).toBe("running");
    expect(info.lastActivityAt).toBeGreaterThanOrEqual(before);
    reg.setStatus("nope", "dead"); // unknown id is a no-op, must not throw
  });

  it("markAllDead marks every session dead", () => {
    const reg = new SessionRegistry();
    reg.add("a", "/x");
    reg.add("b", "/y");
    reg.markAllDead();
    expect(reg.list().every((s) => s.status === "dead")).toBe(true);
  });

  it("list returns all sessions", () => {
    const reg = new SessionRegistry();
    reg.add("a", "/x");
    reg.add("b", "/y");
    expect(reg.list().map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
