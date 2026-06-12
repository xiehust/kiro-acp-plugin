import { fileURLToPath } from "node:url";
import path from "node:path";

export const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.cjs");
