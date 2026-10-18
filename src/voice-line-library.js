const path = require("node:path");

const BUNDLED_CATEGORIES = {
  daily_conversation: "Daily Conversation",
  funny_reactions: "Funny Reactions",
  greeting: "Greeting",
  interactive_conversation: "Interactive Conversation",
  night: "Night",
  work_study: "Work & Study",
};

function bundledClips(root, isReadable = () => true) {
  const clips = [];
  for (const [folder, category] of Object.entries(BUNDLED_CATEGORIES)) {
    const directory = path.join(root, folder);
    let files = [];
    try { files = require("node:fs").readdirSync(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !/\.mp3$/i.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        if (!isReadable(file)) continue;
        clips.push({ path: file, name: entry.name, category, collection: `bundled:${folder}`,
          sourceName: "Bundled Rem voice lines", clipIndex: Number(/_(\d+)\.mp3$/i.exec(entry.name)?.[1]) || 0,
          start: null, end: null });
      } catch { /* Ignore missing or unreadable packaged clips. */ }
    }
  }
  return clips;
}

function registeredClips(collections = {}, isReadable = () => true) {
  const clips = [];
  for (const [collection, entries] of Object.entries(collections || {})) {
    if (!Array.isArray(entries)) continue;
    const category = collection.startsWith("category:")
      ? collection.slice("category:".length)
      : collection === "click" ? "Click voice lines"
        : collection === "idle" ? "Idle voice lines" : "Other";
    for (const entry of entries) {
      const file = typeof entry === "string" ? entry : entry?.path;
      if (typeof file !== "string" || !path.isAbsolute(file) || !/\.mp3$/i.test(file)) continue;
      try {
        if (!isReadable(file)) continue;
        clips.push({ ...(typeof entry === "object" ? entry : {}), path: file,
          name: path.basename(file), category: typeof entry?.category === "string" ? entry.category : category,
          collection, sourceName: entry?.sourceName || "", clipIndex: Number(entry?.clipIndex) || 0,
          start: entry?.start != null && Number.isFinite(Number(entry.start)) ? Number(entry.start) : null,
          end: entry?.end != null && Number.isFinite(Number(entry.end)) ? Number(entry.end) : null });
      } catch { /* A missing or unreadable exported clip is skipped. */ }
    }
  }
  return [...new Map(clips.map((clip) => [clip.path, clip])).values()];
}

function chooseClip(clips, category = "all", previousPath = "", random = Math.random) {
  const categories = Array.isArray(category) ? category : [category];
  const pool = clips.filter((clip) => {
    if (categories.includes("all")) return true;
    return categories.some((value) => value === "click" || value === "idle"
      ? clip.collection === value : clip.category === value);
  });
  if (!pool.length) return null;
  const alternatives = pool.filter((clip) => clip.path !== previousPath);
  const available = alternatives.length ? alternatives : pool;
  const index = Math.min(available.length - 1, Math.floor(Math.max(0, random()) * available.length));
  return available[index];
}

function clipMetadata(sourceName, category, clipIndex, start, end, outputPath) {
  return { sourceName, category, clipIndex, start, end, path: outputPath };
}

function sourceClipFilename(sourceName, clipIndex) {
  const stem = path.basename(String(sourceName || "voice"), path.extname(String(sourceName || "")));
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "voice";
  return `${slug}_${String(Math.max(1, Math.floor(Number(clipIndex) || 1))).padStart(3, "0")}.mp3`;
}

function buildExportRecords(sourcePath, category, segments, outputDirectory, firstClipIndex = 1) {
  const sourceName = path.basename(sourcePath);
  return segments.map((segment, index) => {
    const clipIndex = firstClipIndex + index;
    const outputPath = path.join(outputDirectory, sourceClipFilename(sourceName, clipIndex));
    return clipMetadata(sourceName, category, clipIndex, Number(segment.start), Number(segment.end), outputPath);
  });
}

function isTimeInRange(time, start, end) {
  const parse = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const now = parse(time); const from = parse(start); const to = parse(end);
  if (now === null || from === null || to === null || from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

module.exports = { registeredClips, bundledClips, chooseClip, clipMetadata, sourceClipFilename, buildExportRecords, isTimeInRange };
