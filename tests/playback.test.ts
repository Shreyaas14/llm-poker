import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLAY_PACE, playbackDelay, scheduleAutoStep } from "../lib/playback.ts";
import type { PlayPace } from "../lib/playback.ts";

test("normal six-second playback remains the default", () => {
  assert.equal(DEFAULT_PLAY_PACE, 6);
});

for (const pace of [6, 3] as const) {
  test(`${pace}-second playback waits for its countdown`, t => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10000 });
    let steps = 0;
    const cancel = scheduleAutoStep({ pace, handComplete: false, canAdvance: () => true,
      isBusy: () => false, onAdvance: () => { steps++; }, onCountdown: () => {} });
    t.mock.timers.tick(pace * 1000 - 1);
    assert.equal(steps, 0);
    t.mock.timers.tick(1);
    assert.equal(steps, 1);
    t.mock.timers.tick(10000);
    assert.equal(steps, 1, "each response schedules only one following action");
    cancel();
  });
}

test("realtime actions and hand transitions start without a timer", async t => {
  t.mock.method(globalThis, "setInterval", () => { throw new Error("Realtime introduced a timer"); });
  let steps = 0;
  for (const handComplete of [false, true]) {
    assert.equal(playbackDelay(0, handComplete), 0);
    const cancel = scheduleAutoStep({ pace: 0, handComplete, canAdvance: () => true,
      isBusy: () => false, onAdvance: () => { steps++; }, onCountdown: () => {} });
    await Promise.resolve();
    cancel();
  }
  assert.equal(steps, 2);
  assert.equal(playbackDelay(6, true), 4);
  assert.equal(playbackDelay(3, true), 4);
});

test("realtime does not overlap an unfinished model response", async () => {
  let inFlight = false;
  let steps = 0;
  const options = { pace: 0 as const, handComplete: false, canAdvance: () => !inFlight,
    isBusy: () => inFlight, onAdvance: () => { inFlight = true; steps++; }, onCountdown: () => {} };
  scheduleAutoStep(options);
  scheduleAutoStep(options);
  await Promise.resolve();
  assert.equal(steps, 1);
  inFlight = false;
  scheduleAutoStep(options);
  await Promise.resolve();
  assert.equal(steps, 2, "next response resumes immediately without a countdown");
});

test("pause and effect cleanup cancel a pending realtime action", async () => {
  let steps = 0;
  const cancel = scheduleAutoStep({ pace: 0, handComplete: false, canAdvance: () => true,
    isBusy: () => false, onAdvance: () => { steps++; }, onCountdown: () => {} });
  cancel();
  await Promise.resolve();
  assert.equal(steps, 0);
});

test("paced modes keep the countdown while another client holds the game", t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10000 });
  let busy = true, steps = 0;
  const cancel = scheduleAutoStep({ pace: 3 as PlayPace, handComplete: false, canAdvance: () => !busy,
    isBusy: () => busy, onAdvance: () => { steps++; }, onCountdown: () => {} });
  t.mock.timers.tick(4000);
  assert.equal(steps, 0);
  busy = false;
  t.mock.timers.tick(2999);
  assert.equal(steps, 0);
  t.mock.timers.tick(1);
  assert.equal(steps, 1);
  cancel();
});
