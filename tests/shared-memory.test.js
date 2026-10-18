const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, loadRenderer } = require("./helpers");
const { loadPet } = require("./pet-helpers");
const validation = require("../src/config-validation");

test("shared memories default off, normalize bounded notes, and never extract chat content", () => {
  const app = loadMain();
  app.run('settings = normalizeSettings({}); addChatMessage("user", "Do not save this as a memory"); writeCharacterSessions()');
  assert.equal(app.run("settings.memory.enabled"), false);
  assert.equal(app.run("settings.memory.notes.length"), 0);
  assert.doesNotMatch(app.writes.get(app.run("characterStatePath()")), /Do not save this/);
  const memory = app.run('normalizeMemorySettings({enabled:"true",notes:[null," a\\nb ","x".repeat(1000),...Array(30).fill("note")]})');
  assert.equal(memory.enabled, false);
  assert.equal(memory.notes[0], "a b");
  assert.equal(memory.notes[1].length, 240);
  assert.ok(memory.notes.length <= 20);
});

test("memory saves make no network call and only enabled notes enter outgoing model context", async () => {
  const requests = [];
  const app = loadMain({ fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: "A simple reply" } }] });
  } });
  app.run('settings = normalizeSettings({assistant:{baseUrl:"https://example.test/v1",model:"test",stream:false}}); applyChatConfigPatch({memory:{notes:["Enjoys piano on rainy days"]}})');
  assert.equal(requests.length, 0);
  await app.run('sendChatMessage(null,"Hello")');
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Enjoys piano/);
  app.run('applyChatConfigPatch({memory:{enabled:true}})');
  await app.run('sendChatMessage(null,"Hello again")');
  assert.match(requests.at(-1).messages[0].content, /Enjoys piano/);
  assert.equal(requests.length, 2);
  assert.equal(app.run("settings.memory.notes.length"), 1);
  app.run('applyChatConfigPatch({memory:{enabled:false}})');
  await app.run('sendChatMessage(null,"Another hello")');
  assert.doesNotMatch(requests.at(-1).messages[0].content, /Enjoys piano/);
  assert.equal(app.run("settings.memory.notes.length"), 1);
});

test("shared notes are character-isolated, survive restart without history, and delete from storage", () => {
  const app = loadMain();
  app.run('applyChatConfigPatch({memory:{enabled:true,notes:["First character note"]}}); updateSettings({characterId:"luna"})');
  assert.equal(app.run("settings.memory.enabled"), false);
  assert.equal(app.run("settings.memory.notes.length"), 0);
  app.run('applyChatConfigPatch({memory:{enabled:true,notes:["Second character note"]}}); readSettings(); readCharacterSessions()');
  assert.equal(app.run("settings.memory.notes[0]"), "Second character note");
  assert.equal(app.run("settings.rememberHistory"), false);
  assert.equal(app.run("chatHistory.length"), 0);
  app.run('updateSettings({characterId:"default"}); clearChatHistory()');
  assert.equal(app.run("settings.memory.notes[0]"), "First character note");
  assert.equal(app.run("Object.hasOwn(publicSettings(), 'memory')"), false);
  assert.doesNotMatch(app.writes.get(app.run("settingsPath()")), /character note/);
  app.run('applyChatConfigPatch({memory:{notes:[]}}); readSettings(); readCharacterSessions()');
  const saved = JSON.parse(app.writes.get(app.run("characterStatePath()")));
  assert.equal(saved.settings.memory, undefined);
  assert.equal(saved.characters.default.memory.notes.length, 0);
  assert.doesNotMatch(JSON.stringify(saved), /First character note/);
  assert.match(JSON.stringify(saved), /Second character note/);
});

test("memory changes abort a reply based on outdated notes and discard late completion", async () => {
  let finish;
  const app = loadMain({ fetch: () => new Promise((resolve) => { finish = resolve; }) });
  app.run('settings = normalizeSettings({assistant:{baseUrl:"https://example.test/v1",model:"test"},memory:{enabled:true,notes:["Old note"]}})');
  const pending = app.run('sendChatMessage(null,"Hello")');
  app.run('applyChatConfigPatch({memory:{notes:[]}})');
  assert.equal(app.run("chatRequest"), null);
  finish(Response.json({ choices: [{ message: { content: "Old note reply" } }] }));
  await pending;
  assert.doesNotMatch(app.run("JSON.stringify(chatHistory)"), /Old note reply/);
});

test("failed memory deletion restores the saved notes and enabled state", () => {
  let fail = false;
  const app = loadMain({ fs: { renameSync(from, to) {
    if (fail) throw new Error("disk failure");
    app.writes.set(to, app.writes.get(from)); app.writes.delete(from);
  } } });
  app.run('applyChatConfigPatch({memory:{enabled:true,notes:["Keep this note"]}})');
  fail = true;
  assert.throws(() => app.run('applyChatConfigPatch({memory:{enabled:false,notes:[]}})'), /disk failure/);
  assert.equal(app.run("settings.memory.notes[0]"), "Keep this note");
  assert.equal(app.run("settings.memory.enabled"), true);
});

test("memory limits reject invalid saves instead of silently dropping notes", () => {
  const app = loadMain();
  for (const notes of [Array(21).fill("note"), ["x".repeat(241)], ["two\nlines"], [null], "invalid"]) {
    assert.equal(validation.validate({ memory: { notes } }).field, "memory-notes");
    assert.throws(() => app.run(`applyChatConfigPatch(${JSON.stringify({ memory: { notes } })})`), /validation.memories/);
  }
  assert.equal(validation.validate({ memory: { notes: Array(20).fill("x".repeat(240)) } }), null);
  for (const language of ["en-US", "zh-CN", "ja-JP"]) {
    app.run(`settings = normalizeSettings({language:${JSON.stringify(language)},memory:{enabled:true,notes:["Example note"]}})`);
    assert.match(app.run("personaInstruction()"), /Example note/);
    assert.doesNotMatch(app.run("personaInstruction()"), /prompt\.memories|undefined/);
  }
});

test("memory drafts survive background updates, language and character changes without leaking", () => {
  const ui = loadRenderer("settings.js");
  ui.run('applyChatState({config:{characterId:"default",memory:{enabled:false,notes:[]}}})');
  ui.nodes.get("#memory-enabled").checked = true;
  ui.nodes.get("#memory-notes").value = "First note\n\nSecond note";
  ui.run('applyChatState({config:{characterId:"default",resolvedLanguage:"ja-JP",memory:{enabled:false,notes:[]}},busy:true})');
  assert.equal(ui.run("readConfigForm().memory.notes.length"), 2);
  assert.equal(ui.run("readConfigForm().memory.enabled"), true);
  ui.run('applyChatState({config:{characterId:"luna",memory:{enabled:false,notes:[]}}})');
  assert.equal(ui.nodes.get("#memory-notes").value, "");
  ui.run('applyChatState({config:{characterId:"default",memory:{enabled:false,notes:[]}}})');
  assert.equal(ui.run("readConfigForm().memory.notes[0]"), "First note");
  ui.nodes.get("#clear-memories").events.click();
  assert.equal(ui.run("readConfigForm().memory.notes.length"), 0);
  assert.ok(ui.run("changedFields().length") > 0);
});

test("failed memory save keeps editable notes and the previously persisted state", async () => {
  const ui = loadRenderer("settings.js", { saveChatConfig: async () => { throw new Error("disk failure"); } });
  ui.run('applyChatState({config:{memory:{enabled:false,notes:["Existing"]}}})');
  ui.nodes.get("#memory-notes").value = "New note";
  assert.equal(await ui.run("saveConfig()"), false);
  assert.equal(ui.nodes.get("#memory-notes").value, "New note");
  assert.equal(ui.run("config.memory.notes[0]"), "Existing");
});

test("switching settings tabs starts at the top without resetting the active tab's scroll", () => {
  const ui = loadRenderer("settings.js");
  ui.run('document.querySelector(".settings-content").scrollTop=900; selectTab("memory")');
  assert.equal(ui.nodes.get(".settings-content").scrollTop, 0);
  ui.run('document.querySelector(".settings-content").scrollTop=100; selectTab("memory")');
  assert.equal(ui.nodes.get(".settings-content").scrollTop, 100);
});

test("automatic head touches and greetings use distinct local poses and keep the preferred name", () => {
  const pet = loadPet();
  pet.run('character = normalizeCharacter({id:"luna",states:{...FALLBACK_CHARACTER.states,shy:{row:8,frames:1,interval:900}}}); settings.userName="Alex"; handleClick("head")');
  assert.equal(pet.run("state"), "shy");
  assert.match(pet.bubble.textContent, /Alex/);
  const first = pet.bubble.textContent;
  pet.run('handleClick("greet")');
  assert.equal(pet.run("state"), "waving");
  assert.equal(pet.bubble.textContent, first);
  pet.run('dismissBubble(); interactionReadyAt=0; handleClick("greet")');
  assert.notEqual(pet.bubble.textContent, first);
  assert.equal(pet.audio.length, 0);
});

test("touches neither replace conversations or reminders nor enqueue responses", () => {
  const pet = loadPet();
  pet.run('handlePetMessage({source:"chat",text:"Answer",action:"review",streaming:true,speak:false})');
  for (const call of ['handleClick("head")', "handleLongPress()", "handleDoubleClick()", 'respondToInteraction("drop")']) pet.run(call);
  assert.equal(pet.run("state"), "review");
  assert.equal(pet.bubble.textContent, "Answer");
  assert.equal(pet.run("queuedNotice"), null);
  pet.run('handlePetMessage({clear:true}); handlePetMessage({text:"Reminder",speak:false}); handleClick("head")');
  assert.equal(pet.bubble.textContent, "Reminder");
  pet.run('dismissBubble(); settings.interactionResponses=false; handleClick("head")');
  assert.equal(pet.run("bubbleVisible"), false);
});

test("pointer hit area distinguishes a head touch from a body greeting", () => {
  const pet = loadPet();
  for (const [y, kind] of [[40, "head"], [150, "greet"]]) {
    pet.events.pointerdown({ button: 0, clientY: y, screenX: 50, screenY: y });
    assert.equal(pet.run("dragStart.kind"), kind);
    pet.events.pointercancel();
  }
});

test("dropping gives a local response while manual dragging restores the exact selected frame", () => {
  const pet = loadPet();
  pet.run('dragStart={time:performance.now()}; didDrag=true; endDrag({detail:1})');
  assert.equal(pet.run("bubbleVisible"), true);
  pet.run('dismissBubble(); settings.expressionMode="clickOnly"; setStaticExpression("review",3)');
  pet.events.pointerdown({ button: 0, clientY: 150, screenX: 50, screenY: 150 });
  pet.run('didDrag=true; setState("running")');
  pet.events.pointerup({ detail: 1 });
  assert.equal(pet.run("state"), "review");
  assert.equal(pet.run("frameIndex"), 3);
  assert.equal(pet.run("bubbleVisible"), false);
  pet.run('handleLongPress(); handleDoubleClick(); respondToInteraction("head")');
  assert.equal(pet.run("frameIndex"), 3);
});

test("a double click in manual mode does not suppress the first click after changing modes", () => {
  const pet = loadPet();
  pet.run('settings.expressionMode="clickOnly"; handleDoubleClick(); settings.expressionMode="automatic"; resetAfterSettingsChange(); scheduleSingleClick("head")');
  pet.fireTimer(pet.run("clickTimer"));
  assert.equal(pet.run("state"), "review");
  assert.equal(pet.run("bubbleVisible"), true);
});
