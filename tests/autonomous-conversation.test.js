const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers");

function readyMain() {
  const app = loadMain({ platform: "test" });
  app.run(`
    settings = normalizeSettings({
      assistant: { baseUrl: "https://chat.example/v1", model: "test" },
      autonomousConversation: { enabled: true, minIntervalSeconds: 30, maxIntervalSeconds: 60 }
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
  app.run(`requestAssistantReply = async () => ({ ok: true, reply: "SPEAK: Ferdi, aku kepikiran ramen hangat!", action: "idle" })`);
  await app.run("runAutonomousConversation()");

  assert.deepEqual(JSON.parse(JSON.stringify(app.run("chatHistory.map(({role, content}) => ({role, content}))"))), [
    { role: "assistant", content: "Ferdi, aku kepikiran ramen hangat!" },
  ]);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][2].source"), "chat");
  assert.equal(app.run("sentPetMessages[0][2].speak"), true);
  assert.equal(app.run("scheduledDelays[0] >= 30000 && scheduledDelays[0] <= 60000"), true);

  app.run("autonomousLastSpokeAt = Date.now() - 120000; autonomousTimer = null");
  app.run(`requestAssistantReply = async (prompt) => {
    globalThis.lastAutonomousPrompt = prompt;
    return { ok: true, reply: "SPEAK: Ngomong-ngomong, aku suka suasana hujan." };
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
  assert.equal(app.run("autonomousTimer.delay"), 45000);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.enabled"), false);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.minIntervalSeconds"), 30);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.maxIntervalSeconds"), 60);
  app.run("{ const previousWindow = mainWindow; mainWindow = null; applyChatConfigPatch({ autonomousConversation: { enabled: true, minIntervalSeconds: 45, maxIntervalSeconds: 75 } }); mainWindow = previousWindow; }");
  assert.equal(app.run("settings.autonomousConversation.enabled"), true);
  assert.equal(app.run("settings.autonomousConversation.minIntervalSeconds"), 45);
  assert.equal(app.run("settings.autonomousConversation.maxIntervalSeconds"), 75);
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

test("foreground process names are mapped locally and wait decisions do not add chat messages", async () => {
  const app = readyMain();
  assert.equal(app.run('friendlyForegroundApp("VALORANT-Win64-Shipping")'), "VALORANT");
  assert.equal(app.run('friendlyForegroundApp("Code")'), "Visual Studio Code");
  assert.equal(app.run('friendlyForegroundApp("AfterFX.exe")'), "Adobe After Effects");
  assert.equal(app.run('acceptForegroundActivityLine("not-json")'), false);
  app.run('acceptForegroundActivityLine(JSON.stringify({processName:"VALORANT-Win64-Shipping"})); foregroundActivity.changedAt -= 30000; requestAssistantReply = async () => ({ok:true,reply:"WAIT"})');
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 0);
  assert.equal(app.run("scheduledDelays.at(-1) >= 30000 && scheduledDelays.at(-1) <= 60000"), true);
});

