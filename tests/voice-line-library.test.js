const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { registeredClips, bundledClips, chooseClip, clipMetadata, sourceClipFilename, buildExportRecords, isTimeInRange } = require("../src/voice-line-library");

const clipA = "C:\\voice-output\\greeting_001.mp3";
const clipB = "C:\\voice-output\\greeting_002.mp3";
const longSource = "C:\\project\\Rem voice line\\Greeting.mp3";

test("bundled voice discovery includes split category clips and ignores root recordings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-voice-"));
  try {
    fs.mkdirSync(path.join(root, "greeting"));
    fs.mkdirSync(path.join(root, "daily_conversation"));
    fs.writeFileSync(path.join(root, "Greeting.mp3"), "source recording");
    fs.writeFileSync(path.join(root, "greeting", "greeting_001.mp3"), "clip");
    fs.writeFileSync(path.join(root, "daily_conversation", "daily_conversation_001.mp3"), "clip");
    const clips = bundledClips(root, (file) => fs.statSync(file).size > 0);
    assert.deepEqual(clips.map(({ category }) => category), ["Daily Conversation", "Greeting"]);
    assert.equal(clips.some(({ path: file }) => path.basename(file) === "Greeting.mp3"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("random voice pool contains only registered split clips, never source recordings", () => {
  const clips = registeredClips({
    "category:Greeting": [clipA, clipB],
  }, () => true);
  assert.deepEqual(clips.map((clip) => clip.path), [clipA, clipB]);
  assert.equal(clips.some((clip) => clip.path === longSource), false);
});

test("an empty split collection has no whole-file fallback", () => {
  const clips = registeredClips({}, () => true);
  assert.equal(chooseClip(clips, "all"), null);
});

test("category selection returns one clip and avoids the previous clip when possible", () => {
  const clips = registeredClips({ "category:Greeting": [clipA, clipB] }, () => true);
  const selected = chooseClip(clips, "Greeting", clipA, () => 0);
  assert.equal(selected.path, clipB);
  assert.equal(chooseClip(clips, "Night", "", () => 0), null);
});

test("unreadable and non-MP3 collection entries are excluded", () => {
  const clips = registeredClips({ click: [clipA, "C:\\voice-output\\bad.wav", "C:\\missing\\missing.mp3"] }, (file) => file !== "C:\\missing\\missing.mp3");
  assert.deepEqual(clips.map((clip) => clip.path), [clipA]);
});

test("source metadata retains category, source name, per-source clip number and timestamps", () => {
  const metadata = clipMetadata("Daily Conversation.mp3", "Daily Conversation", 2, 4.25, 6.8, clipB);
  const [clip] = registeredClips({ "category:Daily Conversation": [metadata] }, () => true);
  assert.equal(clip.sourceName, "Daily Conversation.mp3");
  assert.equal(clip.category, "Daily Conversation");
  assert.equal(clip.clipIndex, 2);
  assert.equal(clip.start, 4.25);
  assert.equal(clip.end, 6.8);
  assert.equal(clip.path, clipB);
});

test("source-specific output names use an independent clip number for each source", () => {
  assert.equal(sourceClipFilename("Greeting.mp3", 1), "greeting_001.mp3");
  assert.equal(sourceClipFilename("Daily Conversation.mp3", 2), "daily_conversation_002.mp3");
  assert.equal(sourceClipFilename("Greeting 2.mp3", 1), "greeting_2_001.mp3");
});

test("export records map each selected source segment to a named path and timestamp metadata", () => {
  const records = buildExportRecords("C:\\sources\\Daily Conversation.mp3", "Daily Conversation", [
    { start: 1.1, end: 2.3 }, { start: 4.5, end: 6.75 },
  ], "C:\\output\\daily_conversation", 3);
  assert.equal(records.length, 2);
  assert.equal(records[0].path, "C:\\output\\daily_conversation\\daily_conversation_003.mp3");
  assert.equal(records[0].sourceName, "Daily Conversation.mp3");
  assert.equal(records[0].clipIndex, 3);
  assert.equal(records[0].start, 1.1);
  assert.equal(records[0].end, 2.3);
  assert.equal(records[1].clipIndex, 4);
  assert.equal(records[1].start, 4.5);
  assert.equal(records[1].end, 6.75);
});

test("category pools can combine user-selected categories without repeating the last clip", () => {
  const clips = registeredClips({
    "category:Interactive Conversation": [clipA],
    "category:Funny Reactions": [clipB],
    "category:Greeting": [longSource],
  }, () => true);
  assert.equal(chooseClip(clips, ["Interactive Conversation", "Funny Reactions"], clipA, () => 0).path, clipB);
  assert.equal(chooseClip(clips, ["Interactive Conversation", "Funny Reactions"], clipB, () => 0).path, clipA);
});

test("Night time ranges use local HH:mm boundaries and support crossing midnight", () => {
  assert.equal(isTimeInRange("22:00", "22:00", "05:00"), true);
  assert.equal(isTimeInRange("04:59", "22:00", "05:00"), true);
  assert.equal(isTimeInRange("05:00", "22:00", "05:00"), false);
  assert.equal(isTimeInRange("21:59", "22:00", "05:00"), false);
  assert.equal(isTimeInRange("12:00", "22:00", "22:00"), false);
});
