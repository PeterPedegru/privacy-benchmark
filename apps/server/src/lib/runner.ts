import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

/** This process, as a runner of evaluations and refreshes: host, pid and a per-boot id. */
export const RUNNER_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
