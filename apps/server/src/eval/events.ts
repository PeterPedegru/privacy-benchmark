import { EventEmitter } from "node:events";
import type { RunEvent } from "@pb/core";
import type { DB } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { redact } from "../lib/redact.ts";

export const bus = new EventEmitter();
bus.setMaxListeners(200);

/** Records a progress event. Synchronous for callers: writes are queued in order (see `flushEvents`). */
export type Emit = ((level: RunEvent["level"], stage: string, message: string, data?: Record<string, unknown>) => void) & {
  /** Resolves when every event emitted so far has been written. */
  flush: () => Promise<void>;
};

/**
 * An emitter for one evaluation. Events are written in the order they were emitted, without the caller waiting (a
 * progress line must never slow or fail a stage). Events emitted while a write is in flight go out together in one
 * multi-row insert (the local CLI writes across the internet). A failed write is logged and the queue carries on.
 */
export function makeEmitter(db: DB, evaluationId: string, runId: string | null): Emit {
  let tail: Promise<void> = Promise.resolve();
  type Pending = { ts: string; level: RunEvent["level"]; stage: string; message: string; data?: Record<string, unknown> };
  const pending: Pending[] = [];
  let scheduled = false;
  const drain = async () => {
    scheduled = false;
    while (pending.length) {
      const batch = pending.splice(0, 100);
      const rows = await db
        .insert(schema.runEvents)
        .values(batch.map((b) => ({ evaluationId, runId, ts: b.ts, level: b.level, stage: b.stage, message: b.message.slice(0, 2000), data: b.data ?? null })))
        .returning({ id: schema.runEvents.id });
      batch.forEach((b, i) => {
        const ev: RunEvent = { id: rows[i]?.id ?? 0, evaluationId, ts: b.ts, level: b.level, stage: b.stage, message: b.message, data: b.data };
        bus.emit(`eval:${evaluationId}`, ev);
        if (runId) bus.emit(`run:${runId}`, ev);
        bus.emit("all", ev);
      });
    }
  };
  const emit = ((level, stage, raw, data) => {
    pending.push({ ts: new Date().toISOString(), level, stage, message: redact(raw), data });
    if (scheduled) return;
    scheduled = true;
    tail = tail.then(drain).catch((e) => console.error(`[events] couldn't record events for ${evaluationId}: ${(e as Error).message}`));
  }) as Emit;
  emit.flush = () => tail;
  return emit;
}

/** An emitter that records nothing (tests, scripts and tools called outside an evaluation). */
export function silentEmitter(): Emit {
  const emit = (() => {}) as unknown as Emit;
  emit.flush = async () => {};
  return emit;
}
