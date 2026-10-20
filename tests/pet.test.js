const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPet } = require("./pet-helpers");

test("startup and character changes draw idle immediately and keep animating", async () => {
  const pet = loadPet();
  for (const id of ["first", "second"]) {
    pet.run(`applyAppState({activeCharacter:{...FALLBACK_CHARACTER,id:"${id}",spritePath:"${id}.png"},settings:{expressionMode:"automatic"}})`);
    pet.images.at(-1).events.load();
    await Promise.resolve();
    assert.equal(pet.draws.at(-1), `${id}.png`);
    assert.equal(pet.intervals.size, 1);
    [...pet.intervals.values()][0]();
    assert.equal(pet.run("frameIndex"), 1);
  }
});

test("a stale sprite load cannot overwrite the selected character", async () => {
  const pet = loadPet();
  for (const id of ["first", "second"]) pet.run(`applyAppState({activeCharacter:{...FALLBACK_CHARACTER,id:"${id}",spritePath:"${id}.png"},settings:{expressionMode:"automatic"}})`);
  pet.images[1].events.load();
  await Promise.resolve();
  pet.images[0].events.load();
  await Promise.resolve();
  assert.equal(pet.run("spriteImage.src"), "second.png");
  assert.equal(pet.draws.at(-1), "second.png");
  assert.equal(pet.intervals.size, 1);
});

test("click-only mode advances on the first click and ignores automatic reactions", () => {
  const pet = loadPet();
  pet.run('settings.expressionMode = "clickOnly"; resetAfterSettingsChange()');
  pet.run("handleClick()");
  assert.equal(pet.run("frameIndex"), 1);
  pet.run('handlePetMessage({text:"Time",action:"waving",speak:false})');
  for (const fn of [...pet.timeouts.values(), ...pet.intervals.values()]) fn();
  assert.equal(pet.run("state"), "idle");
  assert.equal(pet.run("frameIndex"), 1);
  pet.run('dragStart = {time:performance.now()-1000}; endDrag({detail:1})');
  assert.equal(pet.run("frameIndex"), 1);
  pet.run("handleDoubleClick()");
  assert.equal(pet.run("frameIndex"), 1);
});

test("music mode overrides chat expressions and restores the active expression when disabled", async () => {
  const pet = loadPet();
  pet.run(`character.states = {
    ...FALLBACK_CHARACTER.states,
    tsundere: { row: 8, frames: 8, interval: 240 },
    angry: { row: 9, frames: 8, interval: 220 },
    listening_music: { row: 10, frames: 8, interval: 260 },
  }`);
  pet.run('applyAppState({musicModeEnabled:true,activeCharacter:{...FALLBACK_CHARACTER,states:character.states},settings:{expressionMode:"automatic"}})');
  pet.images.at(-1).naturalHeight = 11 * 832;
  pet.images.at(-1).events.load();
  await Promise.resolve();
  assert.equal(pet.run("state"), "listening_music");
  pet.run('handlePetMessage({text:"Pujian",action:"tsundere",source:"chat",speak:false})');
  assert.equal(pet.run("state"), "listening_music");
  pet.run('applyAppState({musicModeEnabled:false,settings:{expressionMode:"automatic"}})');
  assert.equal(pet.run("state"), "tsundere");
});

test("new Rem expressions stay inside their mapped rows and unknown states fall back to idle", () => {
  const pet = loadPet();
  pet.run(`character = {...character, frame:{width:768,height:832}, columns:8, states:{
    ...character.states,
    tsundere:{row:8,frames:8,interval:360},
    angry:{row:9,frames:8,interval:280},
    listening_music:{row:10,frames:8,interval:420},
  }}; spriteImage={naturalWidth:6144,naturalHeight:9152};`);
  pet.run('setState("tsundere")');
  assert.equal(pet.run("state"), "tsundere");
  [...pet.intervals.values()][0]();
  assert.equal(pet.run("frameIndex"), 1);
  pet.run('setState("angry")');
  assert.equal(pet.run("state"), "angry");
  pet.run('musicModeEnabled=true; setState("angry")');
  assert.equal(pet.run("state"), "listening_music");
  pet.run('musicModeEnabled=false; setState("not-a-state")');
  assert.equal(pet.run("state"), "idle");
  assert.equal(pet.intervals.size, 1);
});

test("switching expression modes invalidates temporary animation callbacks", () => {
  const pet = loadPet();
  pet.run('playTemporary("waving")');
  const oldCallback = [...pet.timeouts.values()][0];
  pet.run('settings.expressionMode = "clickOnly"; resetAfterSettingsChange(); handleClick()');
  oldCallback();
  assert.equal(pet.run("frameIndex"), 1);
});

test("turning voice off ignores late synthesis and stops current audio", async () => {
  let resolve;
  const pet = loadPet({ synthesizeSpeech: () => new Promise((done) => { resolve = done; }) });
  pet.run('settings.tts = {enabled:true,provider:"custom"}');
  const pending = pet.run('speakText("Reply")');
  await new Promise((done) => setImmediate(done));
  pet.run('applyAppState({settings:{tts:{enabled:false,provider:"none"}}})');
  resolve({ ok: true, audioDataUrl: "first" });
  await pending;
  assert.equal(pet.audio.length, 0);
  pet.run('settings.tts = {enabled:true,provider:"custom"}');
  const playing = pet.run('speakText("Reply")');
  await new Promise((done) => setImmediate(done));
  resolve({ ok: true, audioDataUrl: "second" });
  await playing;
  assert.equal(pet.audio[0].played, true);
  pet.run('applyAppState({settings:{tts:{enabled:false,provider:"none"}}})');
  assert.equal(pet.audio[0].paused, true);
});

test("newer speech wins and clearing chat stops audio", async () => {
  const pending = [];
  const pet = loadPet({ synthesizeSpeech: () => new Promise((resolve) => pending.push(resolve)) });
  pet.run('settings.tts = {enabled:true,provider:"custom"}');
  const first = pet.run('speakText("First")');
  await new Promise((done) => setImmediate(done));
  const second = pet.run('speakText("Second")');
  await new Promise((done) => setImmediate(done));
  pending[1]({ ok: true, audioDataUrl: "second" });
  await second;
  pending[0]({ ok: true, audioDataUrl: "first" });
  await first;
  assert.equal(pet.audio.length, 1);
  assert.equal(pet.audio[0].src, "second");
  pet.run("handlePetMessage({clear:true})");
  assert.equal(pet.audio[0].paused, true);
});

test("voice IPC failures do not reject the pet message handler", async () => {
  const pet = loadPet({ synthesizeSpeech: async () => { throw new Error("Service stopped"); } });
  pet.run('settings.tts = {enabled:true,provider:"custom"}');
  await pet.run('speakText("Reply")');
  assert.equal(pet.audio.length, 0);
});

test("idle voice uses a randomized 30–60 second delay and schedules again only after playback ends", async () => {
  const pet = loadPet({ getRandomVoiceLine: async () => ({ ok: true, data: "clip" }), isChatActive: async () => false });
  pet.run("Math.random = () => 0.5");
  pet.run('applyAppState({settings:{voiceLines:{enabled:true,idleVoiceEnabled:true,idleIntervalMinSeconds:30,idleIntervalMaxSeconds:60,volume:0.4}}})');
  let timer = [...pet.timeouts.keys()].at(-1);
  assert.equal(pet.durations.get(timer), 45000);
  pet.fireTimer(timer);
  await new Promise((done) => setImmediate(done));
  assert.equal(pet.audio.length, 1);
  assert.equal(pet.audio[0].played, true);
  pet.run('playVoiceLine(["Daily Conversation"], false)');
  await new Promise((done) => setImmediate(done));
  assert.equal(pet.audio.length, 1);
  assert.equal([...pet.timeouts.values()].length, 0);
  pet.audio[0].onended();
  timer = [...pet.timeouts.keys()].at(-1);
  assert.equal(pet.durations.get(timer), 45000);
});

test("idle voice defers while chat is focused and never falls back from an empty idle collection", async () => {
  let category;
  let chatActive = true;
  const pet = loadPet({ getRandomVoiceLine: async (requested) => { category = requested; return { ok: false, error: "clips_unavailable" }; }, isChatActive: async () => chatActive });
  pet.run('applyAppState({settings:{voiceLines:{enabled:true,idleVoiceEnabled:true,idleIntervalMinSeconds:30,idleIntervalMaxSeconds:60}}})');
  const timer = [...pet.timeouts.keys()].at(-1);
  pet.fireTimer(timer);
  await new Promise((done) => setImmediate(done));
  assert.equal(pet.audio.length, 0);
  assert.equal(category, undefined);
  assert.equal([...pet.durations.values()].at(-1), 5000);
  chatActive = false;
  pet.run("scheduleIdleVoiceLine(30000)");
  const deferred = [...pet.timeouts.keys()].at(-1);
  pet.fireTimer(deferred);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual([...category], ["Daily Conversation", "Work & Study"]);
  assert.equal(pet.audio.length, 0);
});

test("click playback selects only the configured contextual categories", async () => {
  let requested;
  const pet = loadPet({ getRandomVoiceLine: async (category) => { requested = category; return { ok: false, error: "clips_unavailable" }; } });
  pet.run('applyAppState({settings:{voiceLines:{enabled:true,clickCategories:["Interactive Conversation","Funny Reactions"]}}})');
  pet.run("handleClick()");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual([...requested], ["Interactive Conversation", "Funny Reactions"]);
});

test("startup voice waits for sprite readiness and plays one configured Greeting clip", async () => {
  const requested = [];
  const pet = loadPet({ getRandomVoiceLine: async (category) => { requested.push(category); return { ok: true, data: "hello" }; } });
  pet.run('applyAppState({settings:{voiceLines:{enabled:true,playGreetingOnStartup:true,greetingCategory:"Greeting",clickCategories:["Interactive Conversation"]}}})');
  pet.images[0].events.load();
  await Promise.resolve();
  const timer = [...pet.timeouts.keys()].find((id) => pet.durations.get(id) === 700);
  assert.ok(timer);
  pet.fireTimer(timer);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual([...requested[0]], ["Greeting"]);
  assert.equal(pet.audio.length, 1);
  pet.run('applyAppState({settings:{voiceLines:{enabled:true,playGreetingOnStartup:true,greetingCategory:"Greeting"}}})');
  assert.equal(requested.length, 1);
});

test("Night category is restricted to the configured local time range and can be disabled", () => {
  const pet = loadPet();
  assert.equal(pet.run('isNightCategoryActive(new Date(2026, 0, 1, 22, 0), "22:00", "05:00")'), true);
  assert.equal(pet.run('isNightCategoryActive(new Date(2026, 0, 1, 4, 59), "22:00", "05:00")'), true);
  assert.equal(pet.run('isNightCategoryActive(new Date(2026, 0, 1, 5, 0), "22:00", "05:00")'), false);
  pet.run('settings.voiceLines = {nightEnabled:false,nightCategory:"Night"}');
  assert.deepEqual([...pet.run('allowedVoiceCategories(["Night"])')], []);
});

test("late drag responses cannot restart movement after pointer release", async () => {
  let finish;
  const pet = loadPet({ dragMove: () => new Promise((resolve) => { finish = resolve; }) });
  pet.run('settings.expressionMode = "clickOnly"; resetAfterSettingsChange(); beginDrag({button:0,screenX:0,screenY:0})');
  const pending = [...pet.intervals.values()].at(-1)();
  pet.run("endDrag({detail:1})");
  finish({ dx: 30, dy: 0 });
  await pending;
  assert.equal(pet.run("state"), "idle");
  assert.equal(pet.run("frameIndex"), 1);
});
