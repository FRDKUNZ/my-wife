const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers");

function readyMain() {
  const app = loadMain({ platform: "test" });
  app.run(`
    settings = normalizeSettings({
      assistant: { baseUrl: "https://chat.example/v1", model: "test" },
      autonomousConversation: { enabled: true, minIntervalSeconds: 120, maxIntervalSeconds: 240 }
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
  app.run(`requestAssistantReply = async (prompt) => { globalThis.autonomousPrompt = prompt; return { ok: true, reply: "SPEAK: Ferdi, aku kepikiran ramen hangat!", action: "waving" }; }`);
  await app.run("runAutonomousConversation()");

  assert.deepEqual(JSON.parse(JSON.stringify(app.run("chatHistory.map(({role, content}) => ({role, content}))"))), [
    { role: "assistant", content: "Ferdi, aku kepikiran ramen hangat!" },
  ]);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][2].source"), "chat");
  assert.equal(app.run("sentPetMessages[0][2].speak"), true);
  assert.equal(app.run("sentPetMessages[0][1]"), "waving");
  assert.match(app.run("autonomousPrompt"), /\[expression:state\] SPEAK:/);
  assert.equal(app.run("scheduledDelays.at(-1) >= 120000 && scheduledDelays.at(-1) <= 240000"), true);

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
  assert.equal(app.run("autonomousTimer.delay"), 180000);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.enabled"), false);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.minIntervalSeconds"), 120);
  assert.equal(app.run("normalizeSettings({}).autonomousConversation.maxIntervalSeconds"), 240);
  assert.equal(app.run("normalizeSettings({autonomousConversation:{minIntervalSeconds:30,maxIntervalSeconds:86400}}).autonomousConversation.maxIntervalSeconds"), 86400);
  app.run("{ const previousWindow = mainWindow; mainWindow = null; applyChatConfigPatch({ autonomousConversation: { enabled: true, minIntervalSeconds: 145, maxIntervalSeconds: 175 } }); mainWindow = previousWindow; }");
  assert.equal(app.run("settings.autonomousConversation.enabled"), true);
  assert.equal(app.run("settings.autonomousConversation.minIntervalSeconds"), 145);
  assert.equal(app.run("settings.autonomousConversation.maxIntervalSeconds"), 175);
});

test("autonomous intervals above the native timer limit are safely chained without firing early", () => {
  const app = readyMain();
  app.run("Math.random = () => 0.5; settings.autonomousConversation.minIntervalSeconds = 3000000; settings.autonomousConversation.maxIntervalSeconds = 3000000; scheduleAutonomousConversation(); globalThis.longTimer = autonomousTimer");
  assert.equal(app.run("longTimer.delay"), 2147483647);
  app.run("longTimer.callback()");
  assert.equal(app.run("scheduledDelays.length"), 2);
  assert.equal(app.run("scheduledDelays[1]"), 3000000000 - 2147483647);
  assert.equal(app.run("sentPetMessages.length"), 0);
});

test("autonomous conversation defers while voice playback is active and retries safely after model failure", async () => {
  const app = readyMain();
  app.run("voiceLinePlaying = true");
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 0);
  assert.equal(app.run("scheduledDelays.at(-1)"), 30000);

  app.run("voiceLinePlaying = false; autonomousTimer = null; requestAssistantReply = async () => ({ ok: false })");
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 1);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][0].length > 0"), true);
  assert.equal(app.run("scheduledDelays.at(-1) >= 120000 && scheduledDelays.at(-1) <= 240000"), true);
});

test("an idle settings window does not block autonomous conversation, but active use does", () => {
  const app = readyMain();
  app.run(`
    companionSettingsWindow = { isDestroyed: () => false, isFocused: () => true };
    lastUserActivityAt = Date.now() - 31000;
  `);
  assert.equal(app.run("autonomousCanSpeak()"), true);
  app.run("lastUserActivityAt = Date.now()");
  assert.equal(app.run("autonomousCanSpeak()"), false);
});

test("foreground process names are mapped locally and WAIT decisions use a safe spoken fallback", async () => {
  const app = readyMain();
  assert.equal(app.run('friendlyForegroundApp("VALORANT-Win64-Shipping")'), "VALORANT");
  assert.equal(app.run('friendlyForegroundApp("Code")'), "Visual Studio Code");
  assert.equal(app.run('friendlyForegroundApp("AfterFX.exe")'), "Adobe After Effects");
  assert.equal(app.run('acceptForegroundActivityLine("not-json")'), false);
  app.run('acceptForegroundActivityLine(JSON.stringify({processName:"VALORANT-Win64-Shipping"})); foregroundActivity.changedAt -= 30000; requestAssistantReply = async () => ({ok:true,reply:"WAIT"})');
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 1);
  assert.match(app.run("chatHistory[0].content"), /VALORANT/);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("scheduledDelays.at(-1) >= 120000 && scheduledDelays.at(-1) <= 240000"), true);
});

test("autonomous conversation still sends a fallback line if no AI model is configured", async () => {
  const app = readyMain();
  app.run("settings.assistant.baseUrl = ''; settings.assistant.model = ''");
  await app.run("runAutonomousConversation()");
  assert.equal(app.run("chatHistory.length"), 1);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][2].speak"), true);
});

test("manual autonomous test speaks immediately and leaves its scheduled timer intact", async () => {
  const app = readyMain();
  app.run(`
    scheduleAutonomousConversation();
    globalThis.timerBeforeManualTest = autonomousTimer;
    lastUserActivityAt = Date.now();
    requestAssistantReply = async () => ({ok:true,reply:"SPEAK: Ini pesan uji Rem."});
  `);
  const result = await app.run("runAutonomousConversation({manualTest:true})");
  assert.equal(result.ok, true);
  assert.equal(app.run("sentPetMessages.length"), 1);
  assert.equal(app.run("sentPetMessages[0][0]"), "Ini pesan uji Rem.");
  assert.equal(app.run("autonomousTimer === timerBeforeManualTest"), true);
  assert.equal(app.run("timerBeforeManualTest.cancelled"), false);
});

