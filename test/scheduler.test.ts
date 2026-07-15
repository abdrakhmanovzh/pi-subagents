import test from "node:test";
import assert from "node:assert/strict";
import { HARD_MAX_CONCURRENCY, Scheduler, hasWriteCapability, isReadOnlyTools, validateParallelTools, validateTools } from "../src/scheduler.ts";

test("classifies only the fixed read-only tools as safe", () => {
  assert.equal(isReadOnlyTools(["read", "grep", "find", "ls"]), true);
  assert.equal(isReadOnlyTools(["read", "bash"]), false);
  assert.equal(hasWriteCapability(["read"]), false);
  assert.equal(hasWriteCapability(["write"]), true);
});

test("validates built-in tools", () => {
  assert.match(validateTools([]) ?? "", /At least one tool/);
  assert.match(validateTools(["custom"]) ?? "", /Unknown built-in tool/);
  assert.equal(validateTools(["read", "write"]), undefined);
});

test("rejects write-capable tools in parallel mode", () => {
  const error = validateParallelTools(["read", "bash"]);
  assert.ok(error);
  assert.match(error, /only permits read-only/);
  assert.equal(validateParallelTools(["read", "grep"]), undefined);
});

test("rejects concurrent write leases", () => {
  const scheduler = new Scheduler();
  const first = scheduler.acquire("first", true);
  assert.throws(() => scheduler.acquire("second", true), /parallel writes are not allowed/);
  first.release();
  const second = scheduler.acquire("second", true);
  second.release();
});

test("enforces the configured concurrency limit", () => {
  const scheduler = new Scheduler(2);
  const first = scheduler.acquire("first", false);
  const second = scheduler.acquire("second", false);
  assert.throws(() => scheduler.acquire("third", false), /Concurrency limit reached/);
  first.release();
  second.release();
});

test("lets callers lower concurrency", () => {
  const scheduler = new Scheduler();
  const lease = scheduler.acquire("first", false, 1);
  assert.throws(() => scheduler.acquire("second", false, 1), /Concurrency limit reached \(1\)/);
  lease.release();
});

test("caps requested concurrency at the hard maximum", () => {
  const scheduler = new Scheduler();
  const leases = Array.from({ length: HARD_MAX_CONCURRENCY }, (_, index) => scheduler.acquire(String(index), false, HARD_MAX_CONCURRENCY));
  assert.throws(() => scheduler.acquire("overflow", false, HARD_MAX_CONCURRENCY), /Concurrency limit reached/);
  for (const lease of leases) lease.release();
});
