const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers");

function readyMain() {
  const app = loadMain();
  app.run(`
    settings = normalizeSettings({
      assistant: { baseUrl: "https://chat.example/v1", model: "test" },
      autonomousConversation: { enabled: true, minIntervalSeconds: 120, maxIntervalSeconds: 180 }
    });
    mainWindow = { isDestroyed: () => false, webContents: { send() {} } };
    lastUserActivityAt = Date.now() - 120000;
    globalThis.scheduledDelays = [];
    globalThis.activeTimers = [];
    setTimeout = (callback, delay) => {
      globalThis.scheduledDelays.push(delay);
      const timer = { callback, delay, cancelled: false };
      globalThis.activeTimers.push(timer);
      return timer;
    };
    clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
    sentPetMessages = [];
    sendPetMessage = (...args) => sentPetMessages.push(args);
  `);
  return app;
}

test("autonomous conversation adds an assistant message and schedules a fresh random interval", async () => {
  const app = readyMain();
  app.run(`requestAssistantReply = async () => ({ ok: true, reply: "Ferdi, aku kepikiran ramen hangat!", action: "idle" })`);
  await app.run("runAutonomousConversation()");

  assert.deepEqual(JSON.parse(JSON.stringify(app.run("chatHistory.map(({role, content}) => ({role, content}))"))), [
    { role: "assistant", content: "Ferdi, aku kepikiran ramen hangat!" },
  ]);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][2].source"), "chat");
  assert.equal(app.run("sentPetMessages[0][2].speak"), true);
  assert.equal(app.run("scheduledDelays[0] >= 120000 && scheduledDelays[0] <= 180000"), true);

  app.run("autonomousLastSpokeAt = Date.now() - 120000; autonomousTimer = null");
  app.run(`requestAssistantReply = async (prompt) => {
    globalThis.lastAutonomousPrompt = prompt;
    return { ok: true, reply: "Ngomong-ngomong, aku suka suasana hujan." };
  }`);
  await app.run("runAutonomousConversation()");
  assert.match(app.run("lastAutonomousPrompt"), /Ferdi, aku kepikiran ramen hangat!/);
  assert.equal(app.run("chatHistory.length"), 2);
  assert.equal(app.run("chatHistory.every((message) => message.role === 'assistant')"), true);
});

test("autonomous timer randomizes its delay and replaces the previous timer", () => {
  const app = readyMain();
  app.run("Math.random = () => 0.5; scheduleAutonomousConversation(); const firstTimer = autonomousTimer; scheduleAutonomousConversation(); globalThis.firstTimer = firstTimer");
  assert.equal(app.run("firstTimer.cancelled"), true);
  assert.equal(app.run("autonomousTimer.cancelled"), false);
  assert.equal(app.run("autonomousTimer.delay"), 150000);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.enabled"), false);
});

test("autonomous conversation defers while voice playback is active and retries safely after model failure", async () => {
  const app = readyMain();
  app.run("voiceLinePlaying = true");
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 0);
  assert.equal(app.run("scheduledDelays.at(-1)"), 30000);

  app.run("voiceLinePlaying = false; autonomousTimer = null; requestAssistantReply = async () => ({ ok: false })");
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 0);
  assert.equal(app.run("scheduledDelays.at(-1)"), 300000);
});

