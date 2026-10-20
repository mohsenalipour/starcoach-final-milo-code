"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ModelProvider } = require("../src/core/provider.cjs");
const config = {
  baseURL: "https://example.test/v1",
  model: "coding-model",
  apiKey: "test-key-not-real",
};
const success = (content, finishReason = "stop") => ({
  ok: true,
  json: async () => ({
    choices: [{ finish_reason: finishReason, message: { content } }],
  }),
});

test("JSON mode preserves exact source newlines, quotes and regular expressions", async () => {
  const source = 'const matcher = /\\d+/;\nconsole.log("hello");\n';
  const action = {
    type: "tool",
    step: 0,
    tool: "write_file",
    args: { path: "app.cjs", content: source, expectedHash: null },
    message: "Create source",
  };
  let request;
  const provider = new ModelProvider({
    ...config,
    fetchImpl: async (_url, input) => {
      request = JSON.parse(input.body);
      return success(JSON.stringify(action));
    },
  });
  const result = await provider.next({ plan: { steps: ["Build", "Test"] } });
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.equal(result.args.content, source);
});

test("a route rejecting JSON mode is retried without it, with no model or credential switch", async () => {
  const bodies = [];
  const provider = new ModelProvider({
    ...config,
    fetchImpl: async (_url, input) => {
      bodies.push(JSON.parse(input.body));
      assert.equal(input.headers.Authorization, "Bearer " + config.apiKey);
      if (bodies.length === 1) return { ok: false, status: 400 };
      return success('{"ready":true}');
    },
  });
  await provider.ping();
  await provider.ping();
  assert.equal(bodies.length, 3);
  assert(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[2].response_format, undefined);
  assert(bodies.every((b) => b.model === config.model));
});

test("truncated output is never accepted and gets one larger bounded retry", async () => {
  const budgets = [];
  const provider = new ModelProvider({
    ...config,
    fetchImpl: async (_url, input) => {
      budgets.push(JSON.parse(input.body).max_tokens);
      return budgets.length === 1
        ? success('{"ready":', "length")
        : success('{"ready":true}');
    },
  });
  assert.equal((await provider.ping()).ready, true);
  assert.deepEqual(budgets, [6000, 12000]);
});

test("persistent truncation stops with an explicit output limit error", async () => {
  let requests = 0;
  const provider = new ModelProvider({
    ...config,
    fetchImpl: async () => {
      requests++;
      return success('{"ready":true}', "length");
    },
  });
  await assert.rejects(provider.ping(), (e) => e.code === "MODEL_OUTPUT_LIMIT");
  assert.equal(requests, 2);
});

test("transient connection failures retry once, and persistent connection errors stop", async () => {
  const offline = () =>
    Object.assign(new TypeError("Connection failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
  let recoveredCalls = 0;
  const recovered = new ModelProvider({
    ...config,
    fetchImpl: async () => {
      if (++recoveredCalls === 1) throw offline();
      return success('{"ready":true}');
    },
  });
  assert.equal((await recovered.ping()).ready, true);
  assert.equal(recoveredCalls, 2);
  let failedCalls = 0;
  const unavailable = new ModelProvider({
    ...config,
    fetchImpl: async () => {
      failedCalls++;
      throw offline();
    },
  });
  await assert.rejects(unavailable.ping(), /اتصال/);
  assert.equal(failedCalls, 2);
});
