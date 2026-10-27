const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/proactive-engine");
const { loadMain } = require("./helpers");

const NOW = new Date(2026, 9, 27, 14, 0, 0).getTime();

test("explicit tomorrow plan gets a local next-day follow-up time", () => {
  const result = engine.analyzeUserMessage("Besok aku lanjut memperbaiki animasi", engine.blankState(), { now: NOW });
  assert.equal(result.created[0].kind, "intention");
  const due = new Date(result.created[0].item.dueAt);
  assert.equal(due.getDate(), 28);
  assert.equal(due.getHours(), 9);
});

test("uncertain future wording is not assigned an invented due date", () => {
  const result = engine.analyzeUserMessage("Mungkin suatu saat aku mau memperbaiki animasi", engine.blankState(), { now: NOW });
  assert.equal(result.created.find((item) => item.kind === "intention")?.item.dueAt, null);
});

test("completion and cancellation resolve pending intentions", () => {
  let state = engine.analyzeUserMessage("Besok aku lanjut memperbaiki animasi", engine.blankState(), { now: NOW }).state;
  state = engine.analyzeUserMessage("Animasi sudah berhasil diperbaiki", state, { now: NOW + 1 }).state;
  assert.equal(state.intentions[0].status, "completed");
  state = engine.analyzeUserMessage("Besok aku lanjut mengerjakan desain", state, { now: NOW + 2 }).state;
  state = engine.analyzeUserMessage("Desain batal, aku tidak jadi mengerjakannya", state, { now: NOW + 3 }).state;
  assert.equal(state.intentions[1].status, "cancelled");
});

test("curiosity is unique per topic and marked answered or dismissed", () => {
  let state = engine.analyzeUserMessage("Aku sedang mencoba pendekatan baru untuk animasi karakter yang cukup rumit", engine.blankState(), { now: NOW }).state;
  const count = state.curiosities.length;
  state = engine.analyzeUserMessage("Aku sedang mencoba pendekatan baru untuk animasi karakter yang cukup rumit", state, { now: NOW + 1 }).state;
  assert.equal(state.curiosities.length, count);
  const curiosity = state.curiosities[0]; curiosity.status = "asked";
  state = engine.analyzeUserMessage("Jangan tanya lagi soal animasi karakter", state, { now: NOW + 2 }).state;
  assert.equal(state.curiosities[0].status, "dismissed");
  assert.equal(engine.eligibleCandidate(state, { available: true, topic: "animasi karakter" }, { now: NOW + 100 }).type, "quiet_presence");
});

test("only due relevant candidates pass the local gate; busy, audio and cooldown block", () => {
  let state = engine.analyzeUserMessage("Besok aku lanjut memperbaiki animasi", engine.blankState(), { now: NOW }).state;
  state = engine.expireItems(state, NOW + 20 * 60 * 60_000);
  const context = { available: true, topic: "animasi" };
  assert.equal(engine.eligibleCandidate(state, { ...context, busy: true }, { now: NOW + 20 * 60 * 60_000 }).type, "quiet_presence");
  assert.equal(engine.eligibleCandidate(state, { ...context, audioPlaying: true }, { now: NOW + 20 * 60 * 60_000 }).type, "quiet_presence");
  const candidate = engine.eligibleCandidate(state, context, { now: NOW + 20 * 60 * 60_000 });
  assert.equal(candidate.type, "follow_up");
  state = engine.recordAction(state, candidate, NOW + 20 * 60 * 60_000);
  assert.equal(engine.eligibleCandidate(state, context, { now: NOW + 20 * 60 * 60_000 + 1000 }).reason, "global_cooldown");
});

test("adaptation requires multiple samples and smooths one ignored action", () => {
  let state = engine.blankState();
  state = engine.recordFeedback(state, "curiosity", "ignored", null, NOW);
  assert.deepEqual(engine.adaptation(state, "curiosity"), { sampleCount: 1, multiplier: 1 });
  for (let i = 0; i < 6; i++) state = engine.recordFeedback(state, "curiosity", "ignored");
  const adapted = engine.adaptation(state, "curiosity");
  assert.ok(adapted.multiplier < 1 && adapted.multiplier > 0.25);
});

test("expired curiosity and maximum follow-up attempts are retired", () => {
  let state = engine.analyzeUserMessage("Besok aku lanjut memperbaiki animasi", engine.blankState(), { now: NOW }).state;
  const intention = state.intentions[0]; intention.attempts = engine.DEFAULT_POLICY.maxFollowupAttempts;
  state.curiosities.push({ status: "pending", expiresAt: NOW - 1 });
  state = engine.expireItems(state, NOW);
  assert.equal(state.intentions[0].status, "expired");
  assert.equal(state.curiosities.find((item) => item.expiresAt === NOW - 1).status, "expired");
});

test("proactive state survives the existing per-character session persistence format", () => {
  const app = loadMain({ platform: "test" });
  const state = engine.analyzeUserMessage("Besok aku lanjut memperbaiki animasi", engine.blankState(), { now: NOW }).state;
  app.run(`proactiveState = JSON.parse(${JSON.stringify(JSON.stringify(state))})`);
  const saved = app.run("sessionSnapshot()");
  app.context.testSession = saved;
  app.run("loadCharacterSession(globalThis.testSession)");
  assert.equal(app.run("proactiveState.intentions[0].content"), state.intentions[0].content);
  assert.equal(app.run("proactiveState.intentions[0].dueAt"), state.intentions[0].dueAt);
});
