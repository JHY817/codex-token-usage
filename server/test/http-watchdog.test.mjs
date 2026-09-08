import assert from "node:assert/strict";
import test from "node:test";
import { createParentProcessWatchdog } from "../http.mjs";

function fakeClock() {
  let callback;
  let interval;
  let clearCalls = 0;
  const timer = { unref() {} };
  return {
    timer,
    get callback() {
      return callback;
    },
    get interval() {
      return interval;
    },
    get clearCalls() {
      return clearCalls;
    },
    setIntervalFn(fn, ms) {
      callback = fn;
      interval = ms;
      return timer;
    },
    clearIntervalFn(value) {
      assert.equal(value, timer);
      clearCalls += 1;
    },
  };
}

test("parent watchdog is disabled without a valid native app PID", () => {
  const clock = fakeClock();
  const watchdog = createParentProcessWatchdog({
    parentPid: "not-a-pid",
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });

  assert.equal(watchdog.enabled, false);
  assert.equal(watchdog.expectedParentPid, null);
  assert.equal(clock.callback, undefined);
  assert.equal(clock.clearCalls, 0);
});

test("parent watchdog invokes cleanup when the app disappears", async () => {
  const clock = fakeClock();
  let actualParentPid = 4242;
  let parentAlive = true;
  const orphanEvents = [];
  const watchdog = createParentProcessWatchdog({
    parentPid: "4242",
    intervalMs: 500,
    getParentPid: () => actualParentPid,
    processAlive: () => parentAlive,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    onOrphan: (event) => orphanEvents.push(event),
  });

  assert.equal(watchdog.enabled, true);
  assert.equal(watchdog.expectedParentPid, 4242);
  assert.equal(clock.interval, 500);
  assert.equal(await watchdog.check(), false);
  assert.equal(orphanEvents.length, 0);

  actualParentPid = 1;
  assert.equal(await watchdog.check(), true);
  assert.deepEqual(orphanEvents, [{ expectedParentPid: 4242, actualParentPid: 1 }]);
  assert.equal(clock.clearCalls, 1);
  assert.equal(await watchdog.check(), false);

  // A still-attached child whose expected parent can no longer be signalled
  // is also treated as orphaned, covering the PID-existence fallback.
  const secondClock = fakeClock();
  let secondEvents = 0;
  const second = createParentProcessWatchdog({
    parentPid: 4343,
    getParentPid: () => 4343,
    processAlive: () => false,
    setIntervalFn: secondClock.setIntervalFn,
    clearIntervalFn: secondClock.clearIntervalFn,
    onOrphan: () => {
      secondEvents += 1;
    },
  });
  assert.equal(await second.check(), true);
  assert.equal(secondEvents, 1);
  assert.equal(secondClock.clearCalls, 1);
});

test("stopping parent watchdog prevents later cleanup", async () => {
  const clock = fakeClock();
  let orphanEvents = 0;
  const watchdog = createParentProcessWatchdog({
    parentPid: 4545,
    getParentPid: () => 1,
    processAlive: () => false,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    onOrphan: () => {
      orphanEvents += 1;
    },
  });

  watchdog.stop();
  watchdog.stop();
  assert.equal(clock.clearCalls, 1);
  assert.equal(await watchdog.check(), false);
  assert.equal(orphanEvents, 0);
});
