import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODELS, parseDecision, ProviderError, requestDecision } from "../lib/providers.ts";
import { createHand, getObservation, STYLES } from "../lib/poker.ts";

const hand = createHand(182, 0, 1000, STYLES.map(style => style.id).reverse());
const observation = getObservation(hand, hand.actor!);
const key = "unit-test-key-never-sent-to-a-network";
const responseWith = (content: string, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ finish_reason: "stop", message: { content }, ...extra }] });

test("provider decisions accept only supported action shapes", () => {
  for (const action of ["fold", "check", "call"] as const) assert.deepEqual(parseDecision({ action, raiseTo: null }), { type: action });
  assert.deepEqual(parseDecision({ action: "raise", raiseTo: 85 }), { type: "raise", amount: 85 });
  for (const malformed of [null, undefined, [], {}, "fold", { action: "bet", raiseTo: 30 },
    { action: "raise", raiseTo: "50" }, { action: "raise", raiseTo: 2.5 }, { action: "raise", raiseTo: -2 },
    { action: "raise", raiseTo: Infinity }, { action: "call", raiseTo: 10 }, { action: "fold" }]) {
    assert.throws(() => parseDecision(malformed), ProviderError);
  }
});

test("all four providers receive only the seat observation, strict JSON instructions, and bounded requests", async t => {
  const captured: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    captured.push({ url: String(url), init, body });
    return responseWith('{"action":"call","raiseTo":null}');
  });
  for (const model of DEFAULT_MODELS) assert.deepEqual(await requestDecision(observation, model, key), { type: "call" });
  assert.equal(observation.style?.id, hand.classIds![observation.seat]);
  assert.notEqual(observation.style?.id, STYLES[observation.seat].id, "the request carries the assigned class, not the old provider default");
  assert.equal(captured.length, 4);
  for (let i = 0; i < captured.length; i++) {
    const { url, init, body } = captured[i];
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${key}`);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(body.model, DEFAULT_MODELS[i]); assert.equal(body.max_tokens, 1000);
    assert.equal("tools" in body, false);
    const messages = body.messages as { role: string; content: string }[];
    assert.equal(messages.length, 2);
    assert.deepEqual(JSON.parse(messages[1].content), observation);
    assert.ok(!String(init.body).includes(key));
    for (const field of ["deck", "seed", "market", "rngState"]) assert.ok(!messages[1].content.includes(`"${field}"`));
    assert.ok((JSON.parse(messages[1].content).players as object[]).every(player => !("hole" in player)));
    const format = body.response_format as { type: string; json_schema: { strict: boolean; schema: { additionalProperties: boolean } } };
    assert.equal(format.type, "json_schema"); assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.additionalProperties, false);
  }
});

test("rules feedback requests a correction without changing the observation", async t => {
  let sent: { messages: { role: string; content: string }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return responseWith('{"action":"raise","raiseTo":100}');
  });
  assert.deepEqual(await requestDecision(observation, DEFAULT_MODELS[0], key, "Cannot check facing a bet"), { type: "raise", amount: 100 });
  assert.equal(sent!.messages.length, 3);
  assert.deepEqual(JSON.parse(sent!.messages[1].content), observation);
  assert.match(sent!.messages[2].content, /Cannot check facing a bet/);
  assert.match(sent!.messages[2].content, /observation has not changed/);
});

test("upstream HTTP failures expose useful errors without exposing response bodies", async t => {
  let status = 401;
  t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE_ACCOUNT_DATA SECRET_API_KEY", { status }));
  const expected: [number, RegExp][] = [[401, /valid API key/], [402, /credit|budget/], [429, /busy/], [500, /HTTP 500/]];
  for (const [nextStatus, pattern] of expected) {
    status = nextStatus;
    await assert.rejects(requestDecision(observation, DEFAULT_MODELS[0], key), error => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes("PRIVATE_ACCOUNT_DATA"));
      assert.ok(!error.message.includes("SECRET_API_KEY"));
      return true;
    });
  }
});

test("malformed, refused, missing, and truncated completions cannot become poker actions", async t => {
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const malformed = [
    {}, { choices: [] }, { choices: [{ message: {} }] },
    { choices: [{ message: { content: '{"action":"call","raiseTo":null}', refusal: "refused" } }] },
    { choices: [{ finish_reason: "length", message: { content: '{"action":"call","raiseTo":null}' } }] },
    { choices: [{ message: { content: "I would call." } }] },
    { choices: [{ message: { content: '{"action":"hack","raiseTo":null}' } }] },
    { choices: [{ message: { content: '{"action":"raise","raiseTo":1.5}' } }] },
  ];
  for (const value of malformed) {
    payload = value;
    await assert.rejects(requestDecision(observation, DEFAULT_MODELS[1], key), ProviderError);
  }
});

test("network failures and malformed HTTP JSON reject rather than inventing an action", async t => {
  let failWithNetwork = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (failWithNetwork) throw new DOMException("Test timeout", "TimeoutError");
    return new Response("not JSON", { status: 200 });
  });
  await assert.rejects(requestDecision(observation, DEFAULT_MODELS[2], key), ProviderError);
  failWithNetwork = false;
  await assert.rejects(requestDecision(observation, DEFAULT_MODELS[3], key), SyntaxError);
});


test("live games without personalities receive no style assignment or instruction", async t => {
  const hand = createHand(42, 0, 1000, undefined, false);
  const observation = getObservation(hand, hand.actor!);
  let messages: { role: string; content: string }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    messages = JSON.parse(String(init.body)).messages;
    return responseWith('{"action":"call","raiseTo":null}');
  });
  await requestDecision(observation, DEFAULT_MODELS[0], key);
  assert.equal(JSON.parse(messages[1].content).style, null);
  assert.doesNotMatch(messages[0].content, /assigned playing style/);
  assert.match(messages[0].content, /Maximize your poker chips/);
});
