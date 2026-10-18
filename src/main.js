const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  Notification,
  safeStorage,
  dialog,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const i18n = require("./i18n");
const validation = require("./config-validation");
const { readChatResponse } = require("./chat-response");
const { fishSpeechStyle } = require("./fish-speech-style");
const { AUDIO_LIMIT, ERROR_LIMIT, readResponseBytes, readResponseJson, returnedAudioUrl, audioDataUrl: validateAudioDataUrl, redactServiceText } = require("./network-safety");
const { expressionInstruction, parseCompanionReply } = require("./companion-response");
const { companionBounds } = require("./companion-layout");
const { modelsEndpoint, readModelList } = require("./model-list");
const { readPack, installPack } = require("./character-import");
const { pathToFileURL } = require("node:url");
const voiceLineLibrary = require("./voice-line-library");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const BASE_SIZE = { width: 192, height: 208 };
const BUBBLE_HEIGHT = 132;
const MIN_BUBBLE_WIDTH = 320;
const DEFAULT_CHARACTER_ID = "default";
const CHARACTERS_DIR = path.join(__dirname, "..", "assets", "characters");
const SIZE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const MINUTE_MS = 60 * 1000;
const DEFAULT_SETTINGS = {
  language: "system",
  characterId: DEFAULT_CHARACTER_ID,
  expressionMode: "automatic",
  interactionResponses: true,
  scale: 1,
  alwaysOnTop: true,
  restReminderMinutes: 0,
  autonomousConversation: { enabled: false, minIntervalSeconds: 120, maxIntervalSeconds: 180 },
  voiceLines: { enabled: false, idleVoiceEnabled: false, idleIntervalMinSeconds: 30, idleIntervalMaxSeconds: 60, launchAtStartup: true, playGreetingOnStartup: false, startupGreetingClickFallback: false, clickCategories: ["Interactive Conversation", "Funny Reactions"], idleCategories: ["Daily Conversation", "Work & Study"], greetingCategory: "Greeting", nightCategory: "Night", nightEnabled: false, nightStart: "22:00", nightEnd: "05:00", volume: 0.7, sourceFolder: "", collections: {} },
  assistant: {
    baseUrl: "",
    model: "",
    apiKey: "",
    temperature: 0.7,
    sendTemperature: true,
    maxHistory: 12,
    stream: true,
  },
  tts: {
    enabled: false,
    provider: "none",
    referenceId: "",
    voiceName: "",
    rate: 1,
    pitch: 1,
    volume: 1,
    endpoint: "",
    apiKey: "",
    requestMode: "json",
    textLanguage: "zh",
    promptLanguage: "zh",
    promptText: "",
    referenceAudioPath: "",
    textSplitMethod: "cut5",
    mediaType: "wav",
    customBodyTemplate: "{\"text\":\"{{text}}\"}",
  },
  persona: {
    setupDone: false,
    name: "",
    userName: "",
    relationship: "default",
    customRelationship: "",
    personality: "",
    speakingStyle: "",
    background: "",
    extraRules: "",
  },
  rememberHistory: false,
  memory: { enabled: false, notes: [] },
  affection: {
    enabled: false,
    label: "好感",
    minutesPerPoint: 10,
    activeWindowMinutes: 15,
    happyThreshold: 50,
    closeThreshold: 75,
    lowTone: "保持礼貌但有一点距离感，回复简洁，不要过分亲昵。",
    mediumTone: "自然友好，带一点熟悉感，可以适度关心对方。",
    highTone: "更亲近、更信任，语气可以更温柔主动，但不要失去角色边界。",
  },
};
const DEFAULT_PROFILE = {
  mood: "calm",
  affection: 10,
  energy: 80,
  chatDurationMs: 0,
  affectionCarryMs: 0,
  lastChatAt: 0,
  totalInteractions: 0,
  lastInteractionAt: 0,
  lastLaunchDate: "",
};

let mainWindow;
let chatWindow;
let quickChatWindow;
let companionSettingsWindow;
let settings = { ...DEFAULT_SETTINGS };
let profile = { ...DEFAULT_PROFILE };
let dragSnapshot = null;
let restReminderTimer = null;
let focusTimer = null;
let chatHistory = [];
let chatRequest = null;
let chatRevision = 0;
const chatDrafts = new Map();
let chatDraftVersion = 0;
let autonomousTimer = null;
let autonomousPauseUntil = 0;
let autonomousLastSpokeAt = 0;
let autonomousBusy = false;
let autonomousRequestController = null;
let voiceLinePlaying = false;
let lastUserActivityAt = Date.now();
const autonomousRecentOpeners = [];
let characterSessions = {};
let voiceError = false;
let speechGeneration = 0;
let speechSequence = 0;
let speechSession = null;
let pendingImport = null;
let voiceFolderOverride = "";
let selectedSplitterSource = "";
let lastVoiceOutput = "";
let registeredVoiceCollections = {};
let activeSplitterProcess = null;
let splitterCancelled = false;
let previousVoiceLine = "";
const splitterSessions = new Map();

function syncWindowsStartup() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    // On Windows, explicitly point the login item at the installed/portable app
    // executable. Without `path`, Electron can register the wrong command in
    // some packaged layouts, so Windows then appears to ignore startup launch.
    app.setLoginItemSettings({
      openAtLogin: settings.voiceLines.launchAtStartup === true,
      path: process.execPath,
    });
  } catch { /* Login item support may be unavailable in portable or development builds. */ }
}

function importedCharactersDir() { return path.join(app.getPath("userData"), "characters"); }

async function previewCharacterImport(event, kind) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner, kind === "folder"
    ? { properties: ["openDirectory"] }
    : { properties: ["openFile"], filters: [{ name: "ZIP", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths.length) return { cancelled: true };
  try {
    const pack = readPack(result.filePaths[0], (bytes) => !nativeImage.createFromBuffer(bytes).isEmpty());
    const token = require("node:crypto").randomUUID();
    pendingImport = { pack, token, sender: event.sender.id, expires: Date.now() + 600000 };
    return { token, name: pack.manifest.name, description: pack.manifest.description,
      preview: `data:image/png;base64,${pack.files[pack.manifest.preview].toString("base64")}` };
  } catch { return { error: "invalid_pack" }; }
}

function confirmCharacterImport(event, token) {
  if (!pendingImport || pendingImport.token !== token || pendingImport.sender !== event.sender.id || pendingImport.expires < Date.now()) return { error: "expired" };
  try {
    installPack(pendingImport.pack, importedCharactersDir());
    pendingImport = null;
    return { ok: true, ...chatState() };
  } catch { return { error: "import_failed" }; }
}

async function removeCharacterImport(event, id) {
  if (!/^imported-[a-f0-9]{24}$/.test(id)) return { error: "invalid_id" };
  const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "question", message: t("settings.removeConfirm"),
    buttons: [t("settings.importCancel"), t("settings.remove")], defaultId: 0, cancelId: 0,
  });
  if (result.response !== 1) return { cancelled: true };
  if (settings.characterId === id) updateSettings({ characterId: DEFAULT_CHARACTER_ID });
  fs.rmSync(path.join(importedCharactersDir(), id), { recursive: true, force: true });
  delete characterSessions[id];
  chatDrafts.delete(id);
  writeCharacterSessions();
  return { ok: true, ...chatState() };
}

async function confirmDiscard(event) {
  const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "question", message: t("settings.leave"), buttons: [t("settings.stay"), t("settings.discard")],
    defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

function sessionSnapshot() {
  return {
    persona: { ...settings.persona }, affection: { ...settings.affection },
    memory: normalizeMemorySettings(settings.memory),
    profile: { ...profile }, rememberHistory: settings.rememberHistory === true,
    history: publicChatHistory(),
  };
}

function writeCharacterSessions() {
  characterSessions[settings.characterId] = sessionSnapshot();
  const characters = Object.fromEntries(Object.entries(characterSessions).map(([id, value]) => [id, {
    ...value, history: value.rememberHistory ? value.history : [],
  }]));
  writeJsonAtomically(characterStatePath(), { version: 2, settings: settingsForStorage(), characters });
}

function characterStatePath() { return path.join(app.getPath("userData"), "characters-state.json"); }

function writeJsonAtomically(target, data) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}

function writeLegacyMirror(target, data) {
  // The unified snapshot is authoritative; old versions may still read these mirrors.
  try { writeJsonAtomically(target, data); } catch { /* Never turn a committed save into a failure. */ }
}

function readCharacterSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(characterStatePath(), "utf8"));
    if (![1, 2].includes(data.version) || !data.characters || typeof data.characters !== "object") throw new Error();
    characterSessions = data.characters;
  } catch { characterSessions = {}; }
  if (Object.hasOwn(characterSessions, settings.characterId)) {
    loadCharacterSession(characterSessions[settings.characterId]);
  } else {
    // Legacy global data belongs only to the character selected during migration.
    characterSessions[settings.characterId] = sessionSnapshot();
  }
}

function loadCharacterSession(value = {}) {
  settings.persona = normalizePersonaSettings(value.persona);
  settings.affection = normalizeAffectionSettings(value.affection);
  settings.memory = normalizeMemorySettings(value.memory);
  settings.rememberHistory = value.rememberHistory === true;
  profile = normalizeProfile({ ...DEFAULT_PROFILE, ...value.profile, lastChatAt: 0 });
  chatHistory = Array.isArray(value.history) ? value.history.slice(-80).filter((item) =>
    ["user", "assistant"].includes(item?.role) && typeof item.content === "string")
    .map((item) => ({ role: item.role, content: item.content.slice(0, 100000),
      createdAt: Number(item.createdAt) || 0, failed: item.failed === true })) : [];
}

function isSafeAssetName(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !/[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..")
  );
}

function publicAssetPath(...segments) {
  return ["..", "assets", ...segments].map(encodeURIComponent).join("/");
}

function normalizeCharacterPack(rawPack, folderName) {
  const id = typeof rawPack.id === "string" && rawPack.id.trim() ? rawPack.id.trim() : folderName;
  const name = typeof rawPack.name === "string" && rawPack.name.trim() ? rawPack.name.trim() : id;
  const description = typeof rawPack.description === "string" ? rawPack.description : "";
  const sprite = isSafeAssetName(rawPack.sprite) ? rawPack.sprite : "sprite.png";
  const preview = isSafeAssetName(rawPack.preview) ? rawPack.preview : "preview.png";
  const frame = {
    width: Number(rawPack.frame?.width) || 768,
    height: Number(rawPack.frame?.height) || 832,
  };
  const columns = Number(rawPack.columns) || 8;
  const states = rawPack.states && typeof rawPack.states === "object" ? rawPack.states : {};
  const automaticActions = Array.isArray(rawPack.automaticActions)
    ? rawPack.automaticActions.filter((stateName) => states[stateName])
    : [];
  const clickActions = Array.isArray(rawPack.clickActions)
    ? rawPack.clickActions.filter((stateName) => states[stateName])
    : [];
  const staticExpressions = Array.isArray(rawPack.staticExpressions)
    ? rawPack.staticExpressions.filter((expression) => expression && states[expression.state])
    : [];

  return {
    id,
    name,
    description,
    frame,
    columns,
    states,
    automaticActions,
    clickActions,
    staticExpressions,
    spritePath: publicAssetPath("characters", folderName, sprite),
    previewPath: publicAssetPath("characters", folderName, preview),
    absoluteSpritePath: path.join(CHARACTERS_DIR, folderName, sprite),
  };
}

function readCharacterPack(folderName) {
  if (!isSafeAssetName(folderName)) return null;
  const manifestPath = path.join(CHARACTERS_DIR, folderName, "character.json");
  try {
    const rawPack = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const pack = normalizeCharacterPack(rawPack, folderName);
    if (!pack.states.idle) return null;
    return pack;
  } catch {
    return null;
  }
}

function listCharacterPacks() {
  let imported = [];
  try {
    imported = fs.readdirSync(importedCharactersDir()).filter((id) => /^imported-[a-f0-9]{24}$/.test(id)).map((id) => {
      try {
        const root = path.join(importedCharactersDir(), id);
        const raw = JSON.parse(fs.readFileSync(path.join(root, "character.json"), "utf8"));
        const pack = normalizeCharacterPack(raw, id);
        return { ...pack, id, imported: true, absoluteSpritePath: path.join(root, raw.sprite),
          spritePath: pathToFileURL(path.join(root, raw.sprite)).href,
          previewPath: pathToFileURL(path.join(root, raw.preview)).href };
      } catch { return null; }
    }).filter(Boolean);
  } catch { /* No imported characters yet. */ }
  try {
    return fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readCharacterPack(entry.name))
      .filter(Boolean)
      .concat(imported)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return imported;
  }
}

function getCharacterPack(characterId = settings.characterId) {
  const packs = listCharacterPacks();
  return packs.find((pack) => pack.id === characterId) || packs[0] || null;
}

function publicSettings() {
  const { apiKey, ...assistant } = settings.assistant || DEFAULT_SETTINGS.assistant;
  const { apiKey: ttsApiKey, ...tts } = settings.tts || DEFAULT_SETTINGS.tts;
  const { memory, ...petSettings } = settings;
  return {
    ...petSettings,
    voiceLines: publicVoiceLineSettings(),
    assistant: {
      ...assistant,
      hasApiKey: Boolean(apiKey),
    },
    tts: {
      ...tts,
      hasApiKey: Boolean(ttsApiKey),
    },
  };
}

function publicVoiceLineSettings() {
  const { collections: _collections, ...voiceLines } = settings.voiceLines || DEFAULT_SETTINGS.voiceLines;
  return { ...voiceLines };
}

function appState() {
  return {
    speechGeneration,
    language: settings.language,
    resolvedLanguage: activeLanguage(),
    settings: publicSettings(),
    profile,
    characters: listCharacterPacks().map(({ absoluteSpritePath, ...pack }) => pack),
    activeCharacter: (() => {
      const pack = getCharacterPack();
      if (!pack) return null;
      const { absoluteSpritePath, ...publicPack } = pack;
      return publicPack;
    })(),
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function profilePath() {
  return path.join(app.getPath("userData"), "profile.json");
}

function readSettings() {
  try {
    let parsed;
    try {
      const snapshot = JSON.parse(fs.readFileSync(characterStatePath(), "utf8"));
      if (snapshot.version === 2 && snapshot.settings && typeof snapshot.settings === "object") parsed = snapshot.settings;
    } catch { /* Read the legacy settings on first upgrade. */ }
    if (!parsed) parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    parsed.assistant = {
      ...(parsed.assistant || {}),
      apiKey: readStoredApiKey(parsed.assistant || {}),
    };
    parsed.tts = {
      ...(parsed.tts || {}),
      apiKey: readStoredApiKey(parsed.tts || {}),
    };
    settings = normalizeSettings(parsed);
    voiceFolderOverride = settings.voiceLines?.sourceFolder || "";
    registeredVoiceCollections = settings.voiceLines?.collections || {};
  } catch {
    settings = normalizeSettings(DEFAULT_SETTINGS);
    voiceFolderOverride = "";
    registeredVoiceCollections = {};
  }
}

function readProfile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath(), "utf8"));
    profile = normalizeProfile({ ...DEFAULT_PROFILE, ...parsed });
  } catch {
    profile = { ...DEFAULT_PROFILE };
  }
}

function writeSettings() {
  writeCharacterSessions();
  writeLegacyMirror(settingsPath(), settingsForStorage());
}

function writeProfile() {
  writeCharacterSessions();
  writeLegacyMirror(profilePath(), profile);
}

function readStoredApiKey(rawAssistant) {
  if (typeof rawAssistant.apiKeyEnc === "string" && rawAssistant.apiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(rawAssistant.apiKeyEnc, "base64")).trim();
    } catch {
      return "";
    }
  }
  return typeof rawAssistant.apiKey === "string" ? rawAssistant.apiKey.trim() : "";
}

function settingsForStorage() {
  const stored = JSON.parse(JSON.stringify(settings));
  // Memories live only in their character session, not in global or legacy mirrors.
  delete stored.memory;
  encryptStoredApiKey(stored.assistant);
  encryptStoredApiKey(stored.tts);
  return stored;
}

function encryptStoredApiKey(section) {
  if (!section) return;
  const apiKey = section.apiKey;
  delete section.apiKey;
  delete section.apiKeyEnc;
  if (apiKey && canPersistApiKey()) {
    section.apiKeyEnc = safeStorage.encryptString(apiKey).toString("base64");
  }
}

function canPersistApiKey() {
  return safeStorage.isEncryptionAvailable()
    && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
}

function mergeServiceSettings(current, patch = {}, urlField) {
  const changes = { ...patch };
  if (changes.apiKey === undefined) delete changes.apiKey;
  const merged = { ...current, ...changes };
  // Credentials belong to one endpoint, including its path and transport.
  if (changes.apiKey === undefined && (
    normalizeBaseUrl(merged[urlField]) !== normalizeBaseUrl(current[urlField])
    || (urlField === "endpoint" && merged.provider !== current.provider)
  )) {
    merged.apiKey = "";
  }
  return merged;
}

function normalizeSettings(nextSettings) {
  nextSettings = nextSettings || {};
  const language = i18n.normalizeLanguage(nextSettings.language);
  const assistant = normalizeAssistantSettings(nextSettings?.assistant);
  const tts = normalizeTtsSettings(nextSettings?.tts);
  const persona = normalizePersonaSettings(nextSettings?.persona);
  const affection = normalizeAffectionSettings(nextSettings?.affection);
  const requestedCharacterId = (
    typeof nextSettings.characterId === "string" && nextSettings.characterId.trim()
      ? nextSettings.characterId.trim()
      : DEFAULT_CHARACTER_ID
  );
  const characterId = getCharacterPack(requestedCharacterId)?.id || DEFAULT_CHARACTER_ID;
  const expressionMode = nextSettings.expressionMode === "clickOnly" ? "clickOnly" : "automatic";
  const scale = nearestScale(Number(nextSettings.scale) || 1);
  const alwaysOnTop = nextSettings.alwaysOnTop !== false;
  const restReminderMinutes = [0, 30, 60].includes(Number(nextSettings.restReminderMinutes))
    ? Number(nextSettings.restReminderMinutes)
    : 0;
  const rawAutonomous = { ...DEFAULT_SETTINGS.autonomousConversation, ...(nextSettings.autonomousConversation || {}) };
  const autonomousConversation = {
    enabled: rawAutonomous.enabled === true,
    minIntervalSeconds: Math.round(clampNumber(rawAutonomous.minIntervalSeconds, 120, 3600, 120)),
    maxIntervalSeconds: Math.round(clampNumber(rawAutonomous.maxIntervalSeconds, 120, 3600, 180)),
  };
  autonomousConversation.maxIntervalSeconds = Math.max(autonomousConversation.minIntervalSeconds, autonomousConversation.maxIntervalSeconds);
  const rawVoice = { ...DEFAULT_SETTINGS.voiceLines, ...(nextSettings.voiceLines || {}) };
  const voiceLines = {
    enabled: rawVoice.enabled === true,
    idleVoiceEnabled: rawVoice.idleVoiceEnabled === true,
    idleIntervalMinSeconds: Math.round(clampNumber(rawVoice.idleIntervalMinSeconds, 30, 60, 30)),
    idleIntervalMaxSeconds: Math.round(clampNumber(rawVoice.idleIntervalMaxSeconds, 30, 60, 60)),
    launchAtStartup: rawVoice.launchAtStartup === true,
    playGreetingOnStartup: rawVoice.playGreetingOnStartup === true,
    startupGreetingClickFallback: rawVoice.startupGreetingClickFallback === true,
    clickCategories: normalizeVoiceCategories(rawVoice.clickCategories, ["Interactive Conversation", "Funny Reactions"], rawVoice.clickCategory),
    idleCategories: normalizeVoiceCategories(rawVoice.idleCategories, ["Daily Conversation", "Work & Study"], rawVoice.idleCategory),
    greetingCategory: normalizeVoiceCategory(rawVoice.greetingCategory, "Greeting"),
    nightCategory: normalizeVoiceCategory(rawVoice.nightCategory, "Night"),
    nightEnabled: rawVoice.nightEnabled === true,
    nightStart: normalizeClock(rawVoice.nightStart, "22:00"),
    nightEnd: normalizeClock(rawVoice.nightEnd, "05:00"),
    volume: clampNumber(rawVoice.volume, 0, 1, 0.7),
    sourceFolder: typeof rawVoice.sourceFolder === "string" ? rawVoice.sourceFolder.slice(0, 2048) : "",
    clickCategory: typeof rawVoice.clickCategory === "string" ? rawVoice.clickCategory.slice(0, 60) : "all",
    idleCategory: typeof rawVoice.idleCategory === "string" ? rawVoice.idleCategory.slice(0, 60) : "all",
    collections: rawVoice.collections && typeof rawVoice.collections === "object" ? rawVoice.collections : {},
  };
  voiceLines.idleIntervalMaxSeconds = Math.max(voiceLines.idleIntervalMinSeconds, voiceLines.idleIntervalMaxSeconds);
  return {
    language,
    characterId,
    expressionMode,
    interactionResponses: nextSettings.interactionResponses !== false,
    scale,
    alwaysOnTop,
    restReminderMinutes,
    autonomousConversation,
    voiceLines,
    assistant,
    tts,
    persona,
    affection,
    memory: normalizeMemorySettings(nextSettings.memory),
    rememberHistory: nextSettings.rememberHistory === true,
  };
}

function normalizeVoiceCategory(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function normalizeVoiceCategories(value, fallback, legacy) {
  const values = Array.isArray(value) ? value : typeof legacy === "string" && legacy !== "all" ? [legacy] : fallback;
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, 80)))].slice(0, 12);
}

function normalizeClock(value, fallback) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function normalizeMemorySettings(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    notes: Array.isArray(raw?.notes) ? raw.notes.slice(0, 20)
      .filter((note) => typeof note === "string")
      .map((note) => normalizeCompactText(note, 240)).filter(Boolean) : [],
  };
}

function activeLanguage(nextSettings = settings) {
  return i18n.resolveLanguage(nextSettings.language, app.getLocale());
}

function t(key, variables = {}, nextSettings = settings) {
  return i18n.t(key, variables, activeLanguage(nextSettings));
}

function normalizeAssistantSettings(rawAssistant = {}) {
  const raw = { ...DEFAULT_SETTINGS.assistant, ...(rawAssistant || {}) };
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  const model = normalizeCompactText(raw.model, 300);
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const temperature = clampNumber(raw.temperature, 0, 2, DEFAULT_SETTINGS.assistant.temperature);
  const maxHistory = Math.round(clampNumber(raw.maxHistory, 2, 30, DEFAULT_SETTINGS.assistant.maxHistory));
  return { baseUrl, model, apiKey, temperature, sendTemperature: raw.sendTemperature !== false, maxHistory, stream: raw.stream !== false };
}

function normalizeTtsSettings(rawTts = {}) {
  const raw = { ...DEFAULT_SETTINGS.tts, ...(rawTts || {}) };
  const provider = ["none", "system", "gptsovits", "custom", "fish"].includes(raw.provider)
    ? raw.provider
    : (raw.enabled === true ? "system" : "none");
  const endpoint = normalizeOptionalUrl(raw.endpoint);
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const requestMode = raw.requestMode === "query" ? "query" : "json";
  const textLanguage = normalizeCompactText(raw.textLanguage, 16) || DEFAULT_SETTINGS.tts.textLanguage;
  const promptLanguage = normalizeCompactText(raw.promptLanguage, 16) || DEFAULT_SETTINGS.tts.promptLanguage;
  const promptText = normalizeLongText(raw.promptText, 1000);
  const referenceAudioPath = normalizeLongText(raw.referenceAudioPath, 1000);
  const textSplitMethod = normalizeCompactText(raw.textSplitMethod, 32) || DEFAULT_SETTINGS.tts.textSplitMethod;
  const mediaType = ["wav", "ogg", "aac", "mp3"].includes(raw.mediaType)
    ? raw.mediaType
    : DEFAULT_SETTINGS.tts.mediaType;
  const customBodyTemplate = normalizeLongText(
    raw.customBodyTemplate,
    4000,
  ) || DEFAULT_SETTINGS.tts.customBodyTemplate;
  return {
    enabled: provider !== "none" && raw.enabled !== false,
    provider,
    referenceId: normalizeCompactText(raw.referenceId, 128),
    voiceName: normalizeCompactText(raw.voiceName, 160),
    rate: clampNumber(raw.rate, 0.5, 1.8, DEFAULT_SETTINGS.tts.rate),
    pitch: clampNumber(raw.pitch, 0.5, 1.8, DEFAULT_SETTINGS.tts.pitch),
    volume: clampNumber(raw.volume, 0, 1, DEFAULT_SETTINGS.tts.volume),
    endpoint,
    apiKey,
    requestMode,
    textLanguage,
    promptLanguage,
    promptText,
    referenceAudioPath,
    textSplitMethod,
    mediaType,
    customBodyTemplate,
  };
}

function normalizePersonaSettings(rawPersona = {}) {
  const raw = { ...DEFAULT_SETTINGS.persona, ...(rawPersona || {}) };
  return {
    setupDone: raw.setupDone === true,
    name: normalizeCompactText(raw.name, 80),
    userName: normalizeCompactText(raw.userName, 80),
    relationship: ["default", "friend", "partner", "custom"].includes(raw.relationship) ? raw.relationship : "default",
    customRelationship: normalizeLongText(raw.customRelationship, 600),
    personality: normalizeLongText(raw.personality, 1200),
    speakingStyle: normalizeLongText(raw.speakingStyle, 1200),
    background: normalizeLongText(raw.background, 1600),
    extraRules: normalizeLongText(raw.extraRules, 1600),
  };
}

function normalizeAffectionSettings(rawAffection = {}) {
  const raw = { ...DEFAULT_SETTINGS.affection, ...(rawAffection || {}) };
  return {
    enabled: raw.enabled !== false,
    label: normalizeCompactText(raw.label, 24) || DEFAULT_SETTINGS.affection.label,
    minutesPerPoint: Math.round(clampNumber(
      raw.minutesPerPoint,
      1,
      240,
      DEFAULT_SETTINGS.affection.minutesPerPoint,
    )),
    activeWindowMinutes: Math.round(clampNumber(
      raw.activeWindowMinutes,
      1,
      120,
      DEFAULT_SETTINGS.affection.activeWindowMinutes,
    )),
    happyThreshold: Math.round(clampNumber(raw.happyThreshold, 1, 100, DEFAULT_SETTINGS.affection.happyThreshold)),
    closeThreshold: Math.round(clampNumber(raw.closeThreshold, 1, 100, DEFAULT_SETTINGS.affection.closeThreshold)),
    lowTone: normalizeLongText(raw.lowTone, 800) || DEFAULT_SETTINGS.affection.lowTone,
    mediumTone: normalizeLongText(raw.mediumTone, 800) || DEFAULT_SETTINGS.affection.mediumTone,
    highTone: normalizeLongText(raw.highTone, 800) || DEFAULT_SETTINGS.affection.highTone,
  };
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeOptionalUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeCompactText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeLongText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(numeric, min, max);
}

function normalizeProfile(nextProfile) {
  const mood = ["calm", "happy", "tired", "annoyed"].includes(nextProfile.mood)
    ? nextProfile.mood
    : "calm";
  const affection = Number(nextProfile.affection);
  const energy = Number(nextProfile.energy);
  return {
    mood,
    affection: clamp(Number.isFinite(affection) ? affection : DEFAULT_PROFILE.affection, 0, 100),
    energy: clamp(Number.isFinite(energy) ? energy : DEFAULT_PROFILE.energy, 0, 100),
    chatDurationMs: Math.max(0, Number(nextProfile.chatDurationMs) || 0),
    affectionCarryMs: Math.max(0, Number(nextProfile.affectionCarryMs) || 0),
    lastChatAt: Math.max(0, Number(nextProfile.lastChatAt) || 0),
    totalInteractions: Math.max(0, Number(nextProfile.totalInteractions) || 0),
    lastInteractionAt: Math.max(0, Number(nextProfile.lastInteractionAt) || 0),
    lastLaunchDate: typeof nextProfile.lastLaunchDate === "string" ? nextProfile.lastLaunchDate : "",
  };
}

function nearestScale(scale) {
  return SIZE_PRESETS.reduce((best, value) => (
    Math.abs(value - scale) < Math.abs(best - scale) ? value : best
  ), 1);
}

function displaySize(scale = settings.scale) {
  return {
    width: Math.max(MIN_BUBBLE_WIDTH, Math.round(BASE_SIZE.width * scale)),
    height: Math.round(BASE_SIZE.height * scale) + BUBBLE_HEIGHT,
  };
}

function applyWindowSize(keepCenter = true) {
  if (!mainWindow) return;
  const nextSize = displaySize();
  const bounds = mainWindow.getBounds();
  const x = keepCenter ? Math.round(bounds.x + bounds.width / 2 - nextSize.width / 2) : bounds.x;
  const y = bounds.y + bounds.height - nextSize.height;
  const area = screen.getDisplayMatching(bounds).workArea;
  mainWindow.setBounds({
    x: clamp(x, area.x, Math.max(area.x, area.x + area.width - nextSize.width)),
    y: clamp(y, area.y, Math.max(area.y, area.y + area.height - nextSize.height)),
    ...nextSize,
  }, true);
}

function createWindow() {
  readSettings();
  readProfile();
  readCharacterSessions();
  recordLaunch();
  const size = displaySize();
  const primary = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: Math.round(primary.x + primary.width - size.width - 72),
    y: Math.round(primary.y + primary.height - size.height - 72),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.showInactive());
  mainWindow.on("move", positionQuickChatWindow);
  mainWindow.on("resize", positionQuickChatWindow);
  mainWindow.webContents.on("render-process-gone", () => stopVoice());
  mainWindow.webContents.on("did-start-loading", () => stopVoice());
}

function enableInputMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { type: "separator" }, { role: "selectAll" },
    ]).popup({ window });
  });
}

function positionQuickChatWindow() {
  if (!mainWindow || !quickChatWindow || quickChatWindow.isDestroyed()) return;
  const pet = mainWindow.getBounds();
  quickChatWindow.setBounds(companionBounds(pet, screen.getDisplayMatching(pet).workArea));
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  const primary = screen.getPrimaryDisplay().workArea;
  chatWindow = new BrowserWindow({
    width: 360,
    height: 460,
    minWidth: 320,
    minHeight: 360,
    x: Math.round(primary.x + primary.width - 420),
    y: Math.round(primary.y + primary.height - 560),
    title: t("window.chatTitle"),
    show: false,
    backgroundColor: "#f6f7f9",
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  chatWindow.loadFile(path.join(__dirname, "chat.html"));
  enableInputMenu(chatWindow);
  chatWindow.once("ready-to-show", () => chatWindow.show());
  chatWindow.on("closed", () => {
    chatWindow = null;
  });
}

function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    positionQuickChatWindow();
    quickChatWindow.show();
    quickChatWindow.focus();
    return;
  }

  const pet = mainWindow.getBounds();
  quickChatWindow = new BrowserWindow({
    ...companionBounds(pet, screen.getDisplayMatching(pet).workArea),
    title: t("window.quickChatTitle"),
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: "#00000000",
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  quickChatWindow.loadFile(path.join(__dirname, "quick-chat.html"));
  enableInputMenu(quickChatWindow);
  quickChatWindow.once("ready-to-show", () => quickChatWindow.show());
  quickChatWindow.on("closed", () => {
    quickChatWindow = null;
  });
}

function createCompanionSettingsWindow() {
  if (companionSettingsWindow && !companionSettingsWindow.isDestroyed()) {
    companionSettingsWindow.show();
    companionSettingsWindow.focus();
    return;
  }

  companionSettingsWindow = new BrowserWindow({
    width: 740,
    height: 760,
    minWidth: 560,
    minHeight: 620,
    title: t("window.settingsTitle"),
    show: false,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  companionSettingsWindow.loadFile(path.join(__dirname, "settings.html"));
  enableInputMenu(companionSettingsWindow);
  companionSettingsWindow.once("ready-to-show", () => companionSettingsWindow.show());
  companionSettingsWindow.on("closed", () => {
    companionSettingsWindow = null;
  });
}

function maybeShowInitialPersonaSettings() {
  if (settings.persona?.setupDone) return;
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    createCompanionSettingsWindow();
  }, 900);
}

function updateSettings(patch) {
  const previous = { settings, profile, history: chatHistory, sessions: { ...characterSessions } };
  const targetId = getCharacterPack(patch?.characterId || settings.characterId)?.id;
  if (targetId && targetId !== settings.characterId) {
    cancelPendingChat();
    characterSessions[settings.characterId] = sessionSnapshot();
    settings = { ...settings, characterId: targetId };
    loadCharacterSession(Object.hasOwn(characterSessions, targetId) ? characterSessions[targetId] : {});
  }
  const nextSettings = {
    ...settings,
    ...(patch || {}),
    assistant: mergeServiceSettings(settings.assistant || DEFAULT_SETTINGS.assistant, patch?.assistant, "baseUrl"),
    tts: mergeServiceSettings(settings.tts || DEFAULT_SETTINGS.tts, patch?.tts, "endpoint"),
    persona: {
      ...(settings.persona || DEFAULT_SETTINGS.persona),
      ...((patch && patch.persona) || {}),
    },
    affection: {
      ...(settings.affection || DEFAULT_SETTINGS.affection),
      ...((patch && patch.affection) || {}),
    },
    memory: { ...settings.memory, ...patch?.memory },
    voiceLines: { ...settings.voiceLines, ...(patch?.voiceLines || {}), sourceFolder: voiceFolderOverride || settings.voiceLines?.sourceFolder || "", collections: registeredVoiceCollections },
  };
  const normalized = normalizeSettings(nextSettings);
  if (JSON.stringify(normalized.tts) !== JSON.stringify(settings.tts)) stopVoice();
  if (normalized.characterId !== settings.characterId
    || JSON.stringify(normalized.persona) !== JSON.stringify(settings.persona)
    || JSON.stringify(normalized.memory) !== JSON.stringify(settings.memory)
    || JSON.stringify(normalized.assistant) !== JSON.stringify(settings.assistant)) {
    cancelPendingChat();
  }
  settings = normalized;
  try {
    if (patch?.profile) applyProfileConfigPatch(patch.profile);
    writeSettings();
  } catch (error) {
    settings = previous.settings;
    profile = previous.profile;
    chatHistory = previous.history;
    characterSessions = previous.sessions;
    broadcastChatState();
    throw error;
  }
  syncWindowsStartup();
  scheduleRestReminder();
  scheduleAutonomousConversation();
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
    applyWindowSize();
    mainWindow.webContents.send("app-state-updated", appState());
    mainWindow.webContents.send("chat-state-updated", chatState());
  }
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.setAlwaysOnTop(settings.alwaysOnTop);
    chatWindow.setTitle(t("window.chatTitle"));
    chatWindow.webContents.send("chat-state-updated", chatState());
  }
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.setAlwaysOnTop(settings.alwaysOnTop);
    quickChatWindow.setTitle(t("window.quickChatTitle"));
    quickChatWindow.webContents.send("chat-state-updated", chatState());
  }
  if (companionSettingsWindow && !companionSettingsWindow.isDestroyed()) {
    companionSettingsWindow.setTitle(t("window.settingsTitle"));
    companionSettingsWindow.webContents.send("chat-state-updated", chatState());
  }
  setApplicationMenu();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function recordLaunch() {
  const today = todayKey();
  const affection = settings.affection || DEFAULT_SETTINGS.affection;
  if (profile.lastLaunchDate !== today) {
    profile.energy = clamp(profile.energy + 15, 0, 100);
    profile.mood = affection.enabled && profile.affection >= affection.happyThreshold ? "happy" : "calm";
    profile.lastLaunchDate = today;
    writeProfile();
  }
}

function moodText() {
  return t(`mood.${profile.mood}`) || t("mood.calm");
}

function updateMoodFromInteraction(kind) {
  const now = Date.now();
  const rapid = now - profile.lastInteractionAt < 700;
  const affection = settings.affection || DEFAULT_SETTINGS.affection;
  profile.totalInteractions += 1;
  profile.lastInteractionAt = now;

  if (kind === "doubleClick") {
    profile.energy = clamp(profile.energy - 4, 0, 100);
    profile.mood = profile.energy < 20 ? "tired" : "happy";
  } else if (kind === "chat") {
    profile.energy = clamp(profile.energy - 1, 0, 100);
    profile.mood = profile.energy < 20 ? "tired" : "happy";
  } else if (kind === "longPress") {
    profile.energy = clamp(profile.energy + 1, 0, 100);
    profile.mood = profile.energy < 20 ? "tired" : "calm";
  } else {
    profile.energy = clamp(profile.energy - (rapid ? 7 : 2), 0, 100);
    if (rapid) profile.mood = "annoyed";
    else if (profile.energy < 20) profile.mood = "tired";
    else if (affection.enabled && profile.affection >= affection.happyThreshold) profile.mood = "happy";
    else profile.mood = "calm";
  }

  writeProfile();
  if (mainWindow) {
    mainWindow.webContents.send("app-state-updated", appState());
  }
}

function recordChatTimeProgress(now = Date.now()) {
  const affection = settings.affection || DEFAULT_SETTINGS.affection;
  if (!affection.enabled) {
    profile.lastChatAt = now;
    return 0;
  }

  const previousChatAt = profile.lastChatAt || 0;
  profile.lastChatAt = now;
  if (!previousChatAt) return 0;

  const elapsed = Math.max(0, now - previousChatAt);
  const activeWindowMs = affection.activeWindowMinutes * MINUTE_MS;
  if (!elapsed || elapsed > activeWindowMs) return 0;

  profile.chatDurationMs = Math.max(0, (profile.chatDurationMs || 0) + elapsed);
  profile.affectionCarryMs = Math.max(0, (profile.affectionCarryMs || 0) + elapsed);

  const pointMs = affection.minutesPerPoint * MINUTE_MS;
  const gained = Math.floor(profile.affectionCarryMs / pointMs);
  if (!gained) return 0;

  const before = profile.affection;
  profile.affection = clamp(profile.affection + gained, 0, 100);
  profile.affectionCarryMs %= pointMs;
  return profile.affection - before;
}

function sendPetMessage(text, action = "waving", options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pet-message", { text, action, ...options });
}

function notify(title, body, action) {
  sendPetMessage(body || title, action, { notification: { title, body } });
}

function voiceSourceDirectory() {
  const configured = voiceFolderOverride;
  const candidate = configured || path.join(app.getAppPath(), "Rem voice line");
  return path.resolve(candidate);
}

function voiceFiles() {
  const isReadable = (file) => {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  };
  const registered = voiceLineLibrary.registeredClips(settings.voiceLines?.collections || {}, isReadable);
  const bundled = voiceLineLibrary.bundledClips(path.join(app.getAppPath(), "Rem voice line"), isReadable);
  const seen = new Set(registered.map((clip) => path.resolve(clip.path)));
  return registered.concat(bundled.filter((clip) => !seen.has(path.resolve(clip.path))));
}

function pickVoiceLine(event, category = "all") {
  const file = voiceLineLibrary.chooseClip(voiceFiles(), category, previousVoiceLine);
  if (!file) return { ok: false, error: "clips_unavailable" };
  previousVoiceLine = file.path;
  try {
    const buffer = fs.readFileSync(file.path);
    return { ok: true, name: file.name, category: file.category, metadata: file, data: buffer.toString("base64") };
  } catch { return { ok: false, error: "read_failed" }; }
}

function isSettingsSender(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return Boolean(owner && owner === companionSettingsWindow && !owner.isDestroyed());
}

async function selectVoiceFolder(event) {
  if (!isSettingsSender(event)) return { ok: false };
  const result = await dialog.showOpenDialog(companionSettingsWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const folder = result.filePaths[0];
  if (voiceFilesAt(folder).length === 0) return { ok: false, error: "empty" };
  voiceFolderOverride = folder;
  updateSettings({ voiceLines: { ...settings.voiceLines, sourceFolder: folder } });
  return { ok: true, folder };
}

function voiceFilesAt(folder) {
  try { return fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.mp3$/i.test(entry.name)); }
  catch { return []; }
}

function ffmpegPath() { return process.env.FFMPEG_PATH || "ffmpeg"; }
async function hasFfmpeg() {
  try { await execFileAsync(ffmpegPath(), ["-version"], { windowsHide: true, timeout: 5000 }); return true; }
  catch { return false; }
}

function runSplitterFfmpeg(args, options = {}) {
  if (activeSplitterProcess) return Promise.reject(Object.assign(new Error("Audio processing is already running"), { code: "EBUSY" }));
  splitterCancelled = false;
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath(), args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (activeSplitterProcess === child) activeSplitterProcess = null;
      if (error) { error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
    activeSplitterProcess = child;
  });
}

function cancelVoiceProcessing(event) {
  if (!isSettingsSender(event)) return { ok: false };
  if (!activeSplitterProcess) return { ok: true, cancelled: false };
  splitterCancelled = true;
  activeSplitterProcess.kill();
  return { ok: true, cancelled: true };
}

function keepSplitterSession(id, session) {
  splitterSessions.set(id, session);
  while (splitterSessions.size > 8) splitterSessions.delete(splitterSessions.keys().next().value);
}

async function chooseSplitterSource(event) {
  if (!isSettingsSender(event)) return { ok: false };
  const result = await dialog.showOpenDialog(companionSettingsWindow, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "ogg", "flac"] }] });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  selectedSplitterSource = path.resolve(result.filePaths[0]);
  return { ok: true, source: selectedSplitterSource, name: path.basename(selectedSplitterSource) };
}

async function chooseSplitterFile(event, kind) {
  if (!isSettingsSender(event)) return { ok: false };
  const options = kind === "timestamp"
    ? { properties: ["openFile"], filters: [{ name: "Timestamp JSON", extensions: ["json"] }] }
    : { properties: ["openDirectory", "createDirectory"] };
  const result = await dialog.showOpenDialog(companionSettingsWindow, options);
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  if (kind === "timestamp") {
    try {
      const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
      if (parsed?.schema_version !== "1.0" || !Array.isArray(parsed.clips)) return { ok: false, error: "timestamp_invalid" };
      return { ok: true, path: result.filePaths[0], timestamp: parsed };
    } catch { return { ok: false, error: "timestamp_invalid" }; }
  }
  return { ok: true, path: result.filePaths[0] };
}

async function previewVoiceSegment(event, request) {
  if (!isSettingsSender(event)) return { ok: false };
  const session = splitterSessions.get(request?.id);
  const start = Number(request?.start); const end = Number(request?.end);
  if (!session || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > session.duration) return { ok: false };
  try {
    const { stdout } = await runSplitterFfmpeg(["-hide_banner", "-ss", String(start), "-i", session.source, "-t", String(end - start), "-c:a", "libmp3lame", "-q:a", "3", "-f", "mp3", "pipe:1"], { timeout: 30000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" });
    return { ok: true, data: stdout.toString("base64") };
  } catch { return { ok: false, error: "preview_failed" }; }
}

async function analyzeVoiceFile(event, request) {
  if (!isSettingsSender(event) || typeof request?.source !== "string" || path.resolve(request.source) !== selectedSplitterSource) return { ok: false, error: "invalid" };
  const source = path.resolve(request.source);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return { ok: false, error: "missing" };
  try {
    const { stderr } = await runSplitterFfmpeg(["-hide_banner", "-i", source, "-af", `silencedetect=noise=${clampNumber(request.threshold, -60, -15, -38)}dB:d=${clampNumber(request.silence, 0.15, 3, 0.45)}`, "-f", "null", "-"], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    const log = stderr || "";
    const duration = Number(log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)?.slice(1).reduce((acc, part, i) => acc + Number(part) * [3600, 60, 1][i], 0));
    const timestampClips = request.timestamps?.clips;
    const timestampMatches = request.timestamps?.source_file?.toLowerCase() === path.basename(source).toLowerCase();
    if (timestampMatches && Number.isFinite(duration) && Array.isArray(timestampClips) && timestampClips.length) {
      const segments = timestampClips.map((clip) => ({ start: Number(clip.start), end: Number(clip.end), text: String(clip.text || "") }))
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.start < segment.end && segment.end <= duration);
      if (segments.length === timestampClips.length) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        keepSplitterSession(id, { source, duration, segments, name: path.basename(source, path.extname(source)) });
        return { ok: true, id, duration, segments, ffmpeg: true, timestamps: true, warning: "Loaded supplied timestamps; review boundaries against the audio." };
      }
    }
    const silenceStarts = [...log.matchAll(/silence_start:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    const silenceEnds = [...log.matchAll(/silence_end:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    let cursor = 0;
    const segments = [];
    for (let i = 0; i < silenceStarts.length; i += 1) {
      const utteranceEnd = silenceStarts[i];
      if (utteranceEnd - cursor >= clampNumber(request.minDuration, 0.2, 30, 0.7)) segments.push({ start: Math.max(0, cursor - clampNumber(request.padding, 0, 1, 0.12)), end: Math.min(duration || utteranceEnd, utteranceEnd + clampNumber(request.padding, 0, 1, 0.12)) });
      cursor = Math.max(cursor, silenceEnds[i] ?? utteranceEnd);
    }
    if (Number.isFinite(duration) && duration - cursor >= clampNumber(request.minDuration, 0.2, 30, 0.7)) segments.push({ start: Math.max(0, cursor - clampNumber(request.padding, 0, 1, 0.12)), end: duration });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    keepSplitterSession(id, { source, duration, segments, name: path.basename(source, path.extname(source)) });
    return { ok: true, id, duration, segments, ffmpeg: true, timestampRejected: Boolean(request.timestamps), warning: "Automatic silence boundaries are estimates; review them against the audio." };
  } catch (error) {
    if (splitterCancelled) return { ok: false, error: "cancelled" };
    if (error.code === "ENOENT") return { ok: false, error: "ffmpeg_missing" };
    return { ok: false, error: "analysis_failed", detail: String(error.stderr || error.message || "").slice(0, 300) };
  }
}

async function exportVoiceSegments(event, request) {
  if (!isSettingsSender(event)) return { ok: false, error: "invalid" };
  const session = splitterSessions.get(request?.id);
  if (!session || !Array.isArray(request.segments)) return { ok: false, error: "invalid" };
  const selected = request.segments.map((segment) => ({ start: Number(segment.start), end: Number(segment.end) }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.start < segment.end && segment.end <= session.duration);
  if (!selected.length) return { ok: false, error: "no_segments" };
  const pick = await dialog.showOpenDialog(companionSettingsWindow, { properties: ["openDirectory", "createDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return { cancelled: true };
  const output = pick.filePaths[0];
  const category = normalizeVoiceCategory(request.category, session.name);
  const categoryFolder = category.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "voice";
  const categoryRoot = path.join(output, categoryFolder);
  lastVoiceOutput = path.resolve(categoryRoot);
  fs.mkdirSync(categoryRoot, { recursive: true });
  const sourceName = path.basename(session.source);
  const sourceSlug = path.basename(session.source, path.extname(session.source)).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "voice";
  const existing = voiceFiles().filter((clip) => clip.sourceName.toLowerCase() === sourceName.toLowerCase());
  let nextIndex = existing.reduce((maximum, clip) => Math.max(maximum, clip.clipIndex || 0), 0);
  try {
    for (const file of fs.readdirSync(categoryRoot)) {
      const match = new RegExp(`^${sourceSlug}_(\\d+)\\.mp3$`, "i").exec(file);
      if (match) nextIndex = Math.max(nextIndex, Number(match[1]));
    }
  } catch { /* New output directory. */ }
  const exported = voiceLineLibrary.buildExportRecords(session.source, category, selected, categoryRoot, nextIndex + 1);
  for (let index = 0; index < selected.length; index += 1) {
    companionSettingsWindow.webContents.send("splitter-progress", { current: index + 1, total: selected.length });
    const segment = selected[index];
    const destination = exported[index].path;
    if (fs.existsSync(destination)) { registerExportedVoiceClips(exported.slice(0, index)); return { ok: false, error: "exists", file: path.basename(destination), completed: index }; }
    try {
      const args = ["-hide_banner", "-ss", String(segment.start), "-i", session.source, "-t", String(segment.end - segment.start)];
      if (/\.mp3$/i.test(session.source)) args.push("-c:a", "copy");
      else args.push("-c:a", "libmp3lame", "-q:a", "2");
      args.push("-n", destination);
      await runSplitterFfmpeg(args, { timeout: 120000 });
    } catch { registerExportedVoiceClips(exported.slice(0, index)); return { ok: false, error: splitterCancelled ? "cancelled" : "export_failed", completed: index }; }
  }
  companionSettingsWindow.webContents.send("splitter-progress", { current: selected.length, total: selected.length, done: true });
  registerExportedVoiceClips(exported);
  return { ok: true, count: exported.length, output: categoryRoot, category, registeredByCategory: { [category]: exported.length }, files: exported };
}

function registerExportedVoiceClips(clips) {
  if (!clips.length) return;
  const collections = { ...registeredVoiceCollections };
  for (const clip of clips) {
    const key = `category:${clip.category}`;
    const existing = Array.isArray(collections[key]) ? collections[key] : [];
    if (!existing.some((item) => (typeof item === "string" ? item : item?.path) === clip.path)) collections[key] = [...existing, clip];
  }
  registeredVoiceCollections = collections;
  updateSettings({ voiceLines: { ...settings.voiceLines, collections } });
}

function publicChatConfig() {
  const { apiKey, ...assistant } = settings.assistant || DEFAULT_SETTINGS.assistant;
  const { apiKey: ttsApiKey, ...tts } = settings.tts || DEFAULT_SETTINGS.tts;
  return {
    language: settings.language,
    autonomousConversation: { ...settings.autonomousConversation },
    characterId: settings.characterId,
    resolvedLanguage: activeLanguage(),
    assistant: {
      ...assistant,
      hasApiKey: Boolean(apiKey),
      canPersistApiKey: canPersistApiKey(),
    },
    tts: {
      ...tts,
      hasApiKey: Boolean(ttsApiKey),
      canPersistApiKey: canPersistApiKey(),
    },
    persona: { ...(settings.persona || DEFAULT_SETTINGS.persona) },
    memory: normalizeMemorySettings(settings.memory),
    voiceLines: publicVoiceLineSettings(),
    interactionResponses: settings.interactionResponses !== false,
    affection: { ...(settings.affection || DEFAULT_SETTINGS.affection) },
    rememberHistory: settings.rememberHistory === true,
    profile: {
      affection: profile.affection,
      energy: profile.energy,
      mood: profile.mood,
      chatDurationMs: profile.chatDurationMs,
    },
  };
}

function publicChatHistory() {
  return chatHistory.map((message) => ({ ...message }));
}

function applyChatConfigPatch(patch = {}) {
  const invalid = validation.validate(patch, "all", false);
  if (invalid) throw new Error(invalid.key);
  const assistantPatch = { ...(patch.assistant || {}) };
  if (assistantPatch.apiKey === undefined) {
    delete assistantPatch.apiKey;
  }
  const ttsPatch = { ...(patch.tts || {}) };
  if (ttsPatch.apiKey === undefined) {
    delete ttsPatch.apiKey;
  }
  if (ttsPatch.provider && ttsPatch.enabled === undefined) {
    ttsPatch.enabled = ttsPatch.provider !== "none";
  }
  const settingsPatch = {
    ...(patch.memory !== undefined ? { memory: patch.memory } : {}),
    ...(patch.voiceLines !== undefined ? { voiceLines: patch.voiceLines } : {}),
    ...(patch.interactionResponses !== undefined ? { interactionResponses: patch.interactionResponses } : {}),
    ...(patch.rememberHistory !== undefined ? { rememberHistory: patch.rememberHistory } : {}),
    ...(patch.language !== undefined ? { language: patch.language } : {}),
    ...(patch.characterId !== undefined ? { characterId: patch.characterId } : {}),
    assistant: assistantPatch,
    tts: ttsPatch,
    ...(patch.persona ? { persona: { ...patch.persona, setupDone: true } } : {}),
    affection: { ...(patch.affection || {}) },
    profile: { ...(patch.profile || {}) },
  };
  updateSettings(settingsPatch);
  return publicChatConfig();
}

function applyProfileConfigPatch(patch = {}) {
  profile = { ...profile };
  let changed = false;
  if (patch.affection !== undefined) {
    profile.affection = clampNumber(patch.affection, 0, 100, profile.affection);
    changed = true;
  }
  if (patch.energy !== undefined) {
    profile.energy = clampNumber(patch.energy, 0, 100, profile.energy);
    changed = true;
  }
  return changed;
}

function settingsFromChatConfigPatch(patch = {}) {
  const assistantPatch = { ...(patch.assistant || {}) };
  if (assistantPatch.apiKey === undefined) delete assistantPatch.apiKey;
  const ttsPatch = { ...(patch.tts || {}) };
  if (ttsPatch.apiKey === undefined) delete ttsPatch.apiKey;
  if (ttsPatch.provider && ttsPatch.enabled === undefined) {
    ttsPatch.enabled = ttsPatch.provider !== "none";
  }
  return normalizeSettings({
    ...settings,
    ...(patch.language !== undefined ? { language: patch.language } : {}),
    ...(patch.characterId !== undefined ? { characterId: patch.characterId } : {}),
    assistant: mergeServiceSettings(settings.assistant || DEFAULT_SETTINGS.assistant, assistantPatch, "baseUrl"),
    tts: mergeServiceSettings(settings.tts || DEFAULT_SETTINGS.tts, ttsPatch, "endpoint"),
    persona: {
      ...(settings.persona || DEFAULT_SETTINGS.persona),
      ...(patch.persona || {}),
      setupDone: true,
    },
    affection: {
      ...(settings.affection || DEFAULT_SETTINGS.affection),
      ...(patch.affection || {}),
    },
  });
}

function addChatMessage(role, content, failed = false) {
  const message = {
    role,
    content,
    createdAt: Date.now(),
    failed,
  };
  chatHistory.push(message);
  if (chatHistory.length > 80) {
    chatHistory = chatHistory.slice(-80);
  }
  return message;
}

function chatState() {
  const characters = listCharacterPacks().map((pack) => ({
    id: pack.id,
    name: pack.name,
    description: pack.description,
    previewPath: pack.previewPath,
    spritePath: pack.spritePath,
    stateCount: Object.keys(pack.states || {}).length,
    automaticActionCount: pack.automaticActions.length,
    clickActionCount: pack.clickActions.length,
    imported: pack.imported === true,
  }));
  return {
    language: settings.language,
    resolvedLanguage: activeLanguage(),
    config: publicChatConfig(),
    history: publicChatHistory(),
    revision: chatRevision,
    draft: chatDraftState(),
    busy: Boolean(chatRequest),
    pending: chatRequest ? { content: chatRequest.text, createdAt: chatRequest.createdAt, reply: chatRequest.reply || "" } : null,
    voiceError,
    voice: {
      status: speechSession?.status || "idle",
      enabled: settings.tts.enabled && settings.tts.provider !== "none",
      canReplay: !chatRequest && !speechSession && Boolean(lastSpokenReply()) && settings.tts.enabled && settings.tts.provider !== "none",
    },
    characters,
    character: (() => {
      const pack = getCharacterPack();
      return pack ? {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        previewPath: pack.previewPath,
      } : null;
    })(),
  };
}

function chatDraftState() {
  return { characterId: settings.characterId, revision: chatRevision,
    text: chatDrafts.get(settings.characterId) || "", version: chatDraftVersion };
}

function setChatDraft(event, draft = {}) {
  if (!draft || typeof draft !== "object" || draft.characterId !== settings.characterId || draft.revision !== chatRevision
    || typeof draft.text !== "string") return;
  const text = draft.text.slice(0, 1200);
  if (text) lastUserActivityAt = Date.now();
  if (text) chatDrafts.set(settings.characterId, text);
  else chatDrafts.delete(settings.characterId);
  chatDraftVersion += 1;
  // Mirror edits between composers without persisting unsent text.
  for (const window of [chatWindow, quickChatWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("chat-draft-updated", { ...chatDraftState(),
        acknowledgedEdit: window.webContents === event?.sender ? draft.edit : undefined });
    }
  }
}

function cleanUserMessage(text) {
  return String(text || "").trim().slice(0, 1200);
}

function compactAssistantReply(text) {
  return String(text || "").trim();
}

function llmEndpoint(baseUrl) {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  return cleanBaseUrl.endsWith("/chat/completions")
    ? cleanBaseUrl
    : `${cleanBaseUrl}/chat/completions`;
}

function activeCharacterStyle() {
  const pack = getCharacterPack();
  if (!pack) return t("prompt.defaultStyle");
  if (pack.id === "luna") {
    return t("prompt.lunaStyle");
  }
  return t("prompt.defaultStyle");
}

function personaInstruction() {
  const pack = getCharacterPack();
  const persona = settings.persona || DEFAULT_SETTINGS.persona;
  const affection = settings.affection || DEFAULT_SETTINGS.affection;
  const characterName = persona.name || pack?.name || "Desktop Pet";
  const personaLines = [
    persona.personality ? t("prompt.personality", { text: persona.personality }) : "",
    persona.speakingStyle ? t("prompt.speakingStyle", { text: persona.speakingStyle }) : "",
    persona.background ? t("prompt.background", { text: persona.background }) : "",
    persona.extraRules ? t("prompt.extraRules", { text: persona.extraRules }) : "",
  ].filter(Boolean);
  return [
    t("prompt.role", { name: characterName }),
    personaLines.length ? personaLines.join("\n") : t("prompt.characterStyle", { style: activeCharacterStyle() }),
    persona.userName ? t("prompt.userName", { name: persona.userName }) : "",
    persona.relationship === "custom"
      ? (persona.customRelationship ? t("prompt.relationshipCustom", { text: persona.customRelationship }) : "")
      : (persona.relationship !== "default" ? t(`prompt.relationship.${persona.relationship}`) : ""),
    settings.affection?.enabled ? affectionInstruction() : "",
    settings.memory?.enabled && settings.memory.notes.length
      ? t("prompt.memories", { notes: JSON.stringify(settings.memory.notes) }) : t("prompt.noMemories"),
    expressionInstruction(getCharacterPack()?.states || { idle: {} }),
    t("prompt.defaultLanguage"),
    t("prompt.privacy"),
  ].join("\n");
}

function affectionInstruction() {
  const affection = settings.affection || DEFAULT_SETTINGS.affection;
  if (!affection.enabled) {
    return t("prompt.affectionOff", { energy: profile.energy, mood: moodText() });
  }

  const closeThreshold = Math.max(affection.closeThreshold, affection.happyThreshold);
  let stage = t("prompt.stage.low");
  let tone = affection.lowTone;
  if (profile.affection >= closeThreshold) {
    stage = t("prompt.stage.high");
    tone = affection.highTone;
  } else if (profile.affection >= affection.happyThreshold) {
    stage = t("prompt.stage.medium");
    tone = affection.mediumTone;
  }

  return [
    t("prompt.affectionState", {
      label: affection.label,
      value: profile.affection,
      stage,
      energy: profile.energy,
      mood: moodText(),
    }),
    t("prompt.affectionTone", { label: affection.label, tone }),
    t("prompt.affectionPrivacy", { label: affection.label }),
  ].join("\n");
}

function llmMessagesFor(userText) {
  const maxHistory = settings.assistant.maxHistory || DEFAULT_SETTINGS.assistant.maxHistory;
  const history = chatHistory
    .filter((message) => !message.failed)
    .slice(-maxHistory)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  return [
    { role: "system", content: personaInstruction() },
    ...history,
    { role: "user", content: userText },
  ];
}

function pickAvailableAction(candidates, fallback = "waving") {
  const states = getCharacterPack()?.states || {};
  return candidates.find((stateName) => states[stateName]) || (states[fallback] ? fallback : "idle");
}

function bubblePreview(text) {
  return String(text || "").trim();
}

async function requestAssistantReply(userText, controller = new AbortController(), onProgress) {
  const assistant = settings.assistant || DEFAULT_SETTINGS.assistant;
  if (!assistant.baseUrl || !assistant.model) {
    return {
      reply: t("assistant.noConfig"),
      action: "review",
      ok: false,
    };
  }

  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (assistant.apiKey) {
      headers.Authorization = `Bearer ${assistant.apiKey}`;
    }
    const response = await fetch(llmEndpoint(assistant.baseUrl), {
      method: "POST",
      redirect: "error",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: assistant.model,
        messages: llmMessagesFor(userText),
        ...(assistant.sendTemperature !== false ? { temperature: assistant.temperature } : {}),
        stream: assistant.stream !== false,
      }),
    });

    if (!response.ok) {
      const detail = await responseErrorText(response, [assistant.apiKey]);
      return {
        reply: t("assistant.statusError", {
          status: response.status,
          detail: detail ? `: ${detail}` : "",
        }),
        action: pickAvailableAction(["failed", "review"]),
        ok: false,
      };
    }

    const states = getCharacterPack()?.states || { idle: {} };
    const rawReply = await readChatResponse(response, (raw) => {
      const parsed = parseCompanionReply(raw, states, true);
      if (parsed.text) onProgress?.(parsed.text, parsed.action);
    });
    const parsed = parseCompanionReply(rawReply, states);
    const reply = parsed.text;
    if (!reply) {
      return {
        reply: t("assistant.empty"),
        action: pickAvailableAction(["failed", "review"]),
        ok: false,
      };
    }

    return {
      reply,
      // Missing metadata is not evidence of an emotion, especially with negation.
      action: parsed.action || "idle",
      ok: true,
    };
  } catch (error) {
    const timeoutMessage = error?.name === "AbortError" ? t("assistant.timeout") : t("assistant.unreachable");
    return {
      reply: t("assistant.checkService", { message: timeoutMessage }),
      action: pickAvailableAction(["failed", "review"]),
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testAssistantConnection(_event, patch = {}) {
  const candidate = settingsFromChatConfigPatch(patch);
  const assistant = candidate.assistant || DEFAULT_SETTINGS.assistant;
  if (!assistant.baseUrl || !assistant.model) {
    return { ok: false, message: t("assistant.test.missing", {}, candidate) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (assistant.apiKey) headers.Authorization = `Bearer ${assistant.apiKey}`;
    const response = await fetch(llmEndpoint(assistant.baseUrl), {
      method: "POST",
      redirect: "error",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: assistant.model,
        messages: [
          { role: "system", content: t("assistant.test.system", {}, candidate) },
          { role: "user", content: t("assistant.test.user", {}, candidate) },
        ],
        ...(assistant.sendTemperature !== false ? { temperature: 0 } : {}),
        stream: assistant.stream !== false,
      }),
    });
    if (!response.ok) {
      const detail = await responseErrorText(response, [assistant.apiKey]);
      return {
        ok: false,
        message: t("assistant.test.statusError", {
          status: response.status,
          detail: detail ? `: ${detail}` : "",
        }, candidate),
      };
    }
    const preview = (await readChatResponse(response)).slice(0, 80);
    if (!preview) return { ok: false, message: t("assistant.test.empty", {}, candidate) };
    return { ok: true, message: t("assistant.test.success", { preview }, candidate) };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? t("assistant.test.timeout", {}, candidate)
      : t("assistant.test.failed", {}, candidate);
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function listAssistantModels(_event, patch = {}) {
  const candidate = settingsFromChatConfigPatch(patch);
  const assistant = candidate.assistant;
  if (!validation.validUrl(assistant.baseUrl)) return { ok: false, error: "url" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {};
    if (assistant.apiKey) headers.Authorization = `Bearer ${assistant.apiKey}`;
    const response = await fetch(modelsEndpoint(assistant.baseUrl), { headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, models: await readModelList(response) };
  } catch { return { ok: false, error: "unavailable" }; }
  finally { clearTimeout(timeout); }
}

async function testTtsConnection(_event, patch = {}) {
  const candidate = settingsFromChatConfigPatch(patch);
  const tts = candidate.tts || DEFAULT_SETTINGS.tts;
  if (!tts.enabled || tts.provider === "none") {
    return { ok: false, message: t("tts.test.off", {}, candidate) };
  }
  if (tts.provider === "system") {
    return { ok: true, message: t("tts.test.systemReady", {}, candidate) };
  }
  if (tts.provider === "gptsovits" && !tts.referenceAudioPath) {
    return { ok: false, message: t("tts.test.needReference", {}, candidate) };
  }
  if (tts.provider === "fish" && !tts.referenceId) {
    return { ok: false, message: "Fish Audio reference ID is required." };
  }
  const result = await synthesizeSpeechWithSettings(t("settings.tts.testText", {}, candidate), candidate);
  if (!result.ok) {
    return { ok: false, message: t("tts.test.failed", { error: result.error || "unknown_error" }, candidate) };
  }
  return {
    ok: true,
    message: t("tts.test.success", {}, candidate),
    audioDataUrl: result.audioDataUrl,
  };
}

async function sendChatMessage(_event, rawText, context) {
  if (context && (context.characterId !== settings.characterId || context.revision !== chatRevision)) {
    return { ok: false, cancelled: true, error: "stale_chat", ...chatState() };
  }
  const text = cleanUserMessage(rawText);
  lastUserActivityAt = Date.now();
  if (autonomousBusy) autonomousRequestController?.abort();
  if (!text) {
    return { ok: false, error: "empty_message", ...chatState() };
  }
  if (chatRequest) return { ok: false, error: "chat_busy", ...chatState() };

  stopVoice();
  const request = { text, createdAt: Date.now(), revision: chatRevision, controller: new AbortController() };
  chatRequest = request;
  voiceError = false;
  broadcastChatState();

  sendPetMessage(t("pet.thinking"), pickAvailableAction(["review", "idle"]), { source: "chat", speak: false, streaming: true });
  try {
    const result = await requestAssistantReply(text, request.controller, (reply, action) => {
      if (chatRequest !== request) return;
      request.reply = reply;
      const now = Date.now();
      if (!request.lastProgress || now - request.lastProgress >= 60) {
        request.lastProgress = now;
        broadcastChatState();
        sendPetMessage(bubblePreview(reply), action && action !== request.action ? action : "", { source: "chat", speak: false, streaming: true });
        if (action) request.action = action;
      }
    });
    if (chatRequest !== request) {
      return { ok: false, cancelled: true, revision: request.revision };
    }
    addChatMessage("user", text, !result.ok);
    const assistantMessage = addChatMessage("assistant", result.reply, !result.ok);
    sendPetMessage(result.reply, result.action, {
      source: "chat",
      speak: result.ok,
      bubbleText: bubblePreview(result.reply),
    });
    if (result.ok) recordChatTimeProgress();
    updateMoodFromInteraction("chat");
    return { ok: result.ok, action: result.action, message: assistantMessage,
      history: publicChatHistory(), revision: chatRevision };
  } finally {
    if (chatRequest === request) {
      chatRequest = null;
      broadcastChatState();
    }
  }
}

function autonomousCanSpeak() {
  const chatFocused = [chatWindow, quickChatWindow, companionSettingsWindow]
    .some((window) => window && !window.isDestroyed() && window.isFocused());
  const hasDraft = [...chatDrafts.values()].some((value) => String(value || "").trim());
  return settings.autonomousConversation?.enabled === true
    && Boolean(settings.assistant?.baseUrl && settings.assistant?.model)
    && mainWindow && !mainWindow.isDestroyed()
    && !app.isQuitting && !chatRequest && !autonomousBusy && !speechSession && !voiceLinePlaying
    && !chatFocused && !hasDraft && Date.now() >= autonomousPauseUntil
    && Date.now() - lastUserActivityAt >= 90_000
    && Date.now() - autonomousLastSpokeAt >= 90_000;
}

function scheduleAutonomousConversation(delayOverride = null) {
  clearTimeout(autonomousTimer);
  autonomousTimer = null;
  if (!settings.autonomousConversation?.enabled || app.isQuitting) {
    autonomousRequestController?.abort();
    return;
  }
  const min = settings.autonomousConversation.minIntervalSeconds;
  const max = settings.autonomousConversation.maxIntervalSeconds;
  const delay = delayOverride ?? (min + Math.random() * (max - min)) * 1000;
  autonomousTimer = setTimeout(runAutonomousConversation, delay);
}

async function runAutonomousConversation() {
  autonomousTimer = null;
  if (!settings.autonomousConversation?.enabled || app.isQuitting) return;
  if (!autonomousCanSpeak()) {
    scheduleAutonomousConversation(30_000);
    return;
  }
  autonomousBusy = true;
  autonomousRequestController = new AbortController();
  broadcastChatState();
  const recent = autonomousRecentOpeners.slice(-8).map((item) => `- ${item}`).join("\n") || "- belum ada";
  const openerPrompt = [
    "Mulai percakapan secara spontan dengan Ferdi sebagai Rem. Tulis satu ucapan singkat dalam bahasa Indonesia yang natural, hangat, dan bervariasi; boleh berupa cerita, komentar, candaan, sapaan, atau pertanyaan (jangan selalu bertanya).",
    "Pakai konteks percakapan terakhir jika relevan. Jangan mengaku tahu aktivitas, layar, atau lokasi Ferdi tanpa konteks yang nyata. Hindari mengulang pembuka/topik berikut:",
    recent,
    "Keluarkan hanya ucapan Rem, maksimal dua kalimat. Jangan gunakan ekspresi marker.",
  ].join("\n");
  try {
    const result = await requestAssistantReply(openerPrompt, autonomousRequestController);
    autonomousBusy = false;
    autonomousRequestController = null;
    broadcastChatState();
    if (!result.ok || !result.reply || !autonomousCanSpeak()) {
      scheduleAutonomousConversation(5 * 60_000);
      return;
    }
    addChatMessage("assistant", result.reply);
    autonomousRecentOpeners.push(result.reply.slice(0, 180));
    if (autonomousRecentOpeners.length > 8) autonomousRecentOpeners.shift();
    autonomousLastSpokeAt = Date.now();
    broadcastChatState();
    sendPetMessage(result.reply, result.action || "idle", {
      source: "chat", speak: true, bubbleText: bubblePreview(result.reply),
    });
  } catch {
    scheduleAutonomousConversation(5 * 60_000);
  } finally {
    autonomousBusy = false;
    autonomousRequestController = null;
    broadcastChatState();
    if (!autonomousTimer) scheduleAutonomousConversation();
  }
}

function pauseAutonomousConversation(_event, minutes = 30) {
  autonomousPauseUntil = Date.now() + Math.min(240, Math.max(1, Number(minutes) || 30)) * 60_000;
  autonomousRequestController?.abort();
  scheduleAutonomousConversation(autonomousPauseUntil - Date.now());
  return { ok: true, pauseUntil: autonomousPauseUntil };
}

function broadcastChatState() {
  for (const window of [mainWindow, chatWindow, quickChatWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send("chat-state-updated", chatState());
  }
}

function cancelPendingChat() {
  stopVoice();
  chatRevision += 1;
  const request = chatRequest;
  chatRequest = null;
  request?.controller.abort();
  sendPetMessage("", "", { clear: true, speak: false });
}

function clearChatHistory() {
  cancelPendingChat();
  const previous = chatHistory;
  chatHistory = [];
  try { writeCharacterSessions(); }
  catch (error) { chatHistory = previous; throw error; }
  finally { broadcastChatState(); }
  return chatState();
}

function stopChat() {
  const request = chatRequest;
  cancelPendingChat();
  if (request) {
    addChatMessage("user", request.text, true);
    addChatMessage("assistant", request.reply || t("chat.stopped"), true);
    try { writeCharacterSessions(); }
    finally { broadcastChatState(); }
  }
  broadcastChatState();
  return chatState();
}

function ttsEndpoint(tts = settings.tts || DEFAULT_SETTINGS.tts) {
  if (tts.provider === "gptsovits") {
    return tts.endpoint || "http://127.0.0.1:9880/tts";
  }
  if (tts.provider === "fish") return "https://api.fish.audio/v1/tts";
  return tts.endpoint;
}

function interpolateTemplate(template, text) {
  const replace = (value) => {
    if (typeof value === "string") return value.replaceAll("{{text}}", text);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return JSON.stringify(replace(JSON.parse(template)));
}

function gptSovitsPayload(text, tts = settings.tts || DEFAULT_SETTINGS.tts) {
  return {
    text,
    text_lang: tts.textLanguage || "zh",
    ref_audio_path: tts.referenceAudioPath || "",
    prompt_text: tts.promptText || "",
    prompt_lang: tts.promptLanguage || "zh",
    media_type: tts.mediaType || "wav",
    text_split_method: tts.textSplitMethod || "cut5",
    batch_size: 1,
    speed_factor: tts.rate || 1,
    streaming_mode: false,
  };
}

function appendQuery(url, params) {
  const nextUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      nextUrl.searchParams.set(key, String(value));
    }
  }
  return nextUrl.toString();
}

function audioContentType(response, provider, tts = settings.tts || DEFAULT_SETTINGS.tts) {
  const contentType = response.headers.get("content-type");
  if (/^audio\/(wav|x-wav|wave|mpeg|mp3|mp4|ogg|aac|flac|webm)(;|$)/i.test(contentType || "")) return contentType.split(";")[0];
  if (provider === "gptsovits") return `audio/${tts.mediaType || "wav"}`;
  return "audio/mpeg";
}

async function audioDataFromResponse(response, provider, tts = settings.tts || DEFAULT_SETTINGS.tts, signal) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await readResponseJson(response, Math.ceil(AUDIO_LIMIT / 3) * 4 + 65536);
    const audioValue = data.audioDataUrl || data.audio_url || data.url || data.audio || data.audio_base64;
    if (!audioValue) return null;
    if (typeof audioValue === "string" && audioValue.startsWith("data:")) {
      return validateAudioDataUrl(audioValue);
    }
    if (typeof audioValue === "string" && /^https?:\/\//.test(audioValue)) {
      const target = returnedAudioUrl(audioValue, ttsEndpoint(tts));
      const audioResponse = await fetch(target, { signal, redirect: "error" });
      if (!audioResponse.ok) return null;
      const audioBuffer = await readResponseBytes(audioResponse, AUDIO_LIMIT);
      if (!audioBuffer.length) return null;
      return `data:${audioContentType(audioResponse, provider, tts)};base64,${audioBuffer.toString("base64")}`;
    }
    if (typeof audioValue === "string") {
      const mediaType = provider === "gptsovits" ? tts.mediaType : "mpeg";
      return validateAudioDataUrl(`data:audio/${mediaType || "mpeg"};base64,${audioValue}`);
    }
    return null;
  }
  const buffer = await readResponseBytes(response, AUDIO_LIMIT);
  if (!buffer.length) return null;
  return `data:${audioContentType(response, provider, tts)};base64,${buffer.toString("base64")}`;
}

async function responseErrorText(response, secrets = []) {
  try {
    const body = (await readResponseBytes(response, ERROR_LIMIT)).toString("utf8");
    const contentType = response.headers.get("content-type") || "";
    const sensitive = [...secrets, settings.assistant?.apiKey, settings.tts?.apiKey];
    if (contentType.includes("application/json")) {
      const data = JSON.parse(body);
      const message = data.message || data.error?.message || data.error || data.Exception || JSON.stringify(data);
      return redactServiceText(message, sensitive).replace(/\s+/g, " ").slice(0, 160);
    }
    return redactServiceText(body, sensitive).replace(/\s+/g, " ").slice(0, 160);
  } catch {
    return "";
  }
}

async function synthesizeSpeechWithSettings(rawText, nextSettings = settings, controller = new AbortController()) {
  const text = compactAssistantReply(rawText);
  const tts = nextSettings.tts || DEFAULT_SETTINGS.tts;
  if (!text || !tts.enabled || ["none", "system"].includes(tts.provider)) {
    return { ok: false, skipped: true };
  }

  const endpoint = ttsEndpoint(tts);
  if (!endpoint) {
    return { ok: false, error: "missing_tts_endpoint" };
  }

  if (controller.signal.aborted) return { ok: false, cancelled: true };
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, 45000);
  try {
    const headers = {};
    if (tts.apiKey) headers.Authorization = `Bearer ${tts.apiKey}`;
    let url = endpoint;
    let requestOptions = {
      method: "POST",
      headers,
      signal: controller.signal,
    };

    if (tts.provider === "fish") {
      if (!tts.apiKey || !tts.referenceId) return { ok: false, error: "fish_configuration_required" };
      requestOptions.headers = { ...headers, "Content-Type": "application/json", model: "s2.1-pro-free" };
      requestOptions.body = JSON.stringify({ ...fishSpeechStyle(text), reference_id: tts.referenceId });
    } else if (tts.provider === "gptsovits") {
      const payload = gptSovitsPayload(text, tts);
      if (tts.requestMode === "query") {
        url = appendQuery(endpoint, payload);
        requestOptions = { method: "GET", headers, signal: controller.signal };
      } else {
        requestOptions.headers = { ...headers, "Content-Type": "application/json" };
        requestOptions.body = JSON.stringify(payload);
      }
    } else {
      requestOptions.headers = { ...headers, "Content-Type": "application/json" };
      const payload = JSON.parse(interpolateTemplate(tts.customBodyTemplate, text));
      if (tts.requestMode === "query") {
        if (Object.values(payload).some((value) => value !== null && typeof value === "object")) throw new Error("invalid_query");
        url = appendQuery(endpoint, payload);
        requestOptions = { method: "GET", headers, signal: controller.signal };
      } else {
        requestOptions.body = JSON.stringify(payload);
      }
    }

    const response = await fetch(url, { ...requestOptions, redirect: "error" });
    if (!response.ok) {
      const detail = await responseErrorText(response, [tts.apiKey]);
      return { ok: false, error: detail ? `tts_status_${response.status}: ${detail}` : `tts_status_${response.status}` };
    }
    const audioDataUrl = await audioDataFromResponse(response, tts.provider, tts, controller.signal);
    if (!audioDataUrl) return { ok: false, error: "empty_audio" };
    return { ok: true, audioDataUrl };
  } catch (error) {
    if (controller.signal.aborted && !expired) return { ok: false, cancelled: true };
    if (error?.message === "audio_origin_not_allowed") return { ok: false, error: t("tts.audioOrigin", {}, nextSettings) };
    if (error?.message === "response_too_large") return { ok: false, error: t("tts.responseTooLarge", {}, nextSettings) };
    return { ok: false, error: error?.name === "AbortError" ? "tts_timeout" : "tts_request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function lastSpokenReply() {
  return [...chatHistory].reverse().find((item) => item.role === "assistant" && !item.failed && item.content?.trim());
}

function stopVoice() {
  speechGeneration += 1;
  speechSession?.controller?.abort();
  speechSession = null;
  voiceError = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("speech-stopped", speechGeneration);
  }
  broadcastChatState();
  return chatState();
}

function beginSpeech(event, generation) {
  if (!mainWindow || event.sender !== mainWindow.webContents || generation !== speechGeneration
    || !settings.tts.enabled || settings.tts.provider === "none") return null;
  speechSession?.controller?.abort();
  speechSession = { id: ++speechSequence, status: "preparing", controller: null };
  voiceError = false;
  broadcastChatState();
  return speechSession.id;
}

function speechStateChanged(event, change) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !speechSession
    || change?.id !== speechSession.id) return;
  if (["idle", "error"].includes(change.status)) {
    speechSession.controller?.abort();
    speechSession = null;
    voiceError = change.status === "error";
  } else if (["preparing", "playing"].includes(change.status)) {
    speechSession.status = change.status;
  } else return;
  broadcastChatState();
}

function replaySpeech() {
  const reply = lastSpokenReply();
  if (!mainWindow || mainWindow.isDestroyed() || chatRequest || speechSession || !reply
    || !settings.tts.enabled || settings.tts.provider === "none") return chatState();
  speechSession = { id: ++speechSequence, status: "preparing", controller: null };
  voiceError = false;
  broadcastChatState();
  sendPetMessage(reply.content, "idle", { source: "chat" });
  return chatState();
}

async function synthesizeSpeech(event, request) {
  const session = speechSession;
  if (!mainWindow || event.sender !== mainWindow.webContents || !session || request?.id !== session.id
    || session.controller || typeof request.text !== "string" || Array.from(request.text).length > (settings.tts.provider === "fish" ? 3000 : 800)) {
    return { ok: false, cancelled: true };
  }
  const controller = new AbortController();
  session.controller = controller;
  try {
    const result = await synthesizeSpeechWithSettings(request.text, settings, controller);
    return speechSession === session ? result : { ok: false, cancelled: true };
  } finally {
    if (session.controller === controller) session.controller = null;
  }
}

function showCurrentTime() {
  const language = activeLanguage();
  const time = new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  notify(t("app.name"), t("notify.time", { time }), "waving");
}

function startFocusTimer() {
  clearTimeout(focusTimer);
  notify(t("notify.focusStartTitle"), t("notify.focusStartBody"), "review");
  focusTimer = setTimeout(() => {
    notify(t("notify.focusEndTitle"), t("notify.focusEndBody"), "waving");
  }, 25 * 60 * 1000);
}

function scheduleRestReminder() {
  clearInterval(restReminderTimer);
  restReminderTimer = null;
  if (!settings.restReminderMinutes) return;
  restReminderTimer = setInterval(() => {
    notify(t("notify.restTitle"), t("notify.restBody"), "waving");
  }, settings.restReminderMinutes * 60 * 1000);
}

function showContextMenu() {
  const language = activeLanguage();
  const characterItems = listCharacterPacks().map((character) => ({
    label: character.name,
    type: "radio",
    checked: settings.characterId === character.id,
    click: () => updateSettings({ characterId: character.id }),
  }));

  const scaleItems = SIZE_PRESETS.map((scale) => ({
    label: `${Math.round(scale * 100)}%`,
    type: "radio",
    checked: Math.abs(settings.scale - scale) < 0.01,
    click: () => updateSettings({ scale }),
  }));

  const restReminderItems = [
    { label: t("menu.off"), value: 0 },
    { label: t("menu.every30Minutes"), value: 30 },
    { label: t("menu.every60Minutes"), value: 60 },
  ].map((item) => ({
    label: item.label,
    type: "radio",
    checked: settings.restReminderMinutes === item.value,
    click: () => updateSettings({ restReminderMinutes: item.value }),
  }));

  const languageItems = i18n.LANGUAGE_OPTIONS.map((option) => ({
    label: i18n.languageLabel(option.value, language),
    type: "radio",
    checked: settings.language === option.value,
    click: () => updateSettings({ language: option.value }),
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: t("menu.character"),
      enabled: characterItems.length > 0,
      submenu: characterItems,
    },
    {
      label: t("menu.expressionMode"),
      submenu: [
        {
          label: t("menu.automaticExpression"),
          type: "radio",
          checked: settings.expressionMode === "automatic",
          click: () => updateSettings({ expressionMode: "automatic" }),
        },
        {
          label: t("menu.clickExpression"),
          type: "radio",
          checked: settings.expressionMode === "clickOnly",
          click: () => updateSettings({ expressionMode: "clickOnly" }),
        },
      ],
    },
    {
      label: t("menu.size"),
      submenu: scaleItems,
    },
    {
      label: t("menu.alwaysOnTop"),
      type: "checkbox",
      checked: settings.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked }),
    },
    {
      label: t("menu.utility"),
      submenu: [
        { label: t("menu.showCurrentTime"), click: showCurrentTime },
        { label: t("menu.startFocus"), click: startFocusTimer },
        {
          label: t("menu.restReminder"),
          submenu: restReminderItems,
        },
      ],
    },
    {
      label: t("menu.chat"),
      submenu: [
        { label: t("menu.quickInput"), click: createQuickChatWindow },
        { label: t("menu.fullChat"), click: createChatWindow },
        { label: t("menu.chatSettings"), click: createCompanionSettingsWindow },
      ],
    },
    {
      label: t("menu.language"),
      submenu: languageItems,
    },
    { type: "separator" },
    { label: t("menu.resetPosition"), click: resetPosition },
    { label: t("menu.quit"), accelerator: "CommandOrControl+Q", click: () => app.quit() },
  ]);

  menu.popup({ window: mainWindow });
}

function resetPosition() {
  if (!mainWindow) return;
  const size = displaySize();
  const primary = screen.getPrimaryDisplay().workArea;
  mainWindow.setBounds({
    width: size.width,
    height: size.height,
    x: Math.round(primary.x + primary.width - size.width - 72),
    y: Math.round(primary.y + primary.height - size.height - 72),
  }, true);
}

function beginDrag() {
  if (!mainWindow) return;
  dragSnapshot = {
    pointer: screen.getCursorScreenPoint(),
    bounds: mainWindow.getBounds(),
  };
}

function moveDrag() {
  if (!mainWindow || !dragSnapshot) return { dx: 0, dy: 0 };
  const pointer = screen.getCursorScreenPoint();
  const dx = pointer.x - dragSnapshot.pointer.x;
  const dy = pointer.y - dragSnapshot.pointer.y;
  mainWindow.setPosition(
    Math.round(dragSnapshot.bounds.x + dx),
    Math.round(dragSnapshot.bounds.y + dy),
    false,
  );
  return { dx, dy };
}

function endDrag() {
  dragSnapshot = null;
}

function iconImage() {
  const sprite = getCharacterPack()?.absoluteSpritePath || "";
  return nativeImage.createFromPath(sprite).resize({ width: 32, height: 32 });
}

function setApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: t("app.name"),
      submenu: [
        { label: t("menu.quickInput"), accelerator: "CommandOrControl+Shift+Space", click: createQuickChatWindow },
        { label: t("menu.fullChat"), accelerator: "CommandOrControl+Shift+C", click: createChatWindow },
        { label: t("menu.chatSettings"), click: createCompanionSettingsWindow },
        { type: "separator" },
        { label: t("menu.quit"), accelerator: "CommandOrControl+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu" },
  ]));
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.setName(t("app.name"));
  createWindow();
  syncWindowsStartup();

  ipcMain.handle("get-app-state", () => appState());
  ipcMain.handle("get-random-voice-line", (event, category, test = false) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner.isDestroyed() || (owner !== mainWindow && !(test && owner === companionSettingsWindow)) || (!test && !settings.voiceLines.enabled)) return { ok: false, error: "disabled" };
    return pickVoiceLine(event, category);
  });
  ipcMain.handle("list-voice-lines", async (event) => isSettingsSender(event)
    ? { folder: voiceSourceDirectory(), sourceCount: voiceFilesAt(voiceSourceDirectory()).length,
      files: voiceFiles().map(({ name, category, sourceName, clipIndex, start, end, path: filePath }) => ({ name, category, sourceName, clipIndex, start, end, path: filePath })), ffmpeg: await hasFfmpeg() }
    : { folder: "", sourceCount: 0, files: [], ffmpeg: false });
  ipcMain.handle("choose-voice-folder", selectVoiceFolder);
  ipcMain.handle("choose-splitter-source", chooseSplitterSource);
  ipcMain.handle("choose-splitter-file", chooseSplitterFile);
  ipcMain.handle("analyze-voice-file", analyzeVoiceFile);
  ipcMain.handle("cancel-voice-processing", cancelVoiceProcessing);
  ipcMain.handle("preview-voice-segment", previewVoiceSegment);
  ipcMain.handle("export-voice-segments", exportVoiceSegments);
  ipcMain.handle("open-voice-output", async (event, folder) => {
    if (!isSettingsSender(event) || typeof folder !== "string" || path.resolve(folder) !== lastVoiceOutput || !fs.existsSync(folder)) return { ok: false };
    const error = await shell.openPath(folder);
    return { ok: !error, error };
  });
  ipcMain.handle("check-ffmpeg", async (event) => isSettingsSender(event) && hasFfmpeg());
  ipcMain.handle("get-chat-state", () => chatState());
  ipcMain.handle("is-chat-active", () => Boolean(
    (chatWindow && !chatWindow.isDestroyed() && chatWindow.isFocused())
    || (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isFocused())
  ));
  ipcMain.handle("pause-autonomous-conversation", pauseAutonomousConversation);
  ipcMain.on("voice-line-playback", (_event, playing) => { voiceLinePlaying = playing === true; });
  ipcMain.handle("save-chat-config", (_event, patch) => applyChatConfigPatch(patch));
  ipcMain.handle("test-assistant-connection", testAssistantConnection);
  ipcMain.handle("list-assistant-models", listAssistantModels);
  ipcMain.handle("test-tts-connection", testTtsConnection);
  ipcMain.handle("send-chat-message", sendChatMessage);
  ipcMain.handle("clear-chat-history", clearChatHistory);
  ipcMain.handle("stop-chat", stopChat);
  ipcMain.on("set-chat-draft", setChatDraft);
  ipcMain.handle("confirm-discard", confirmDiscard);
  ipcMain.handle("preview-character-import", previewCharacterImport);
  ipcMain.handle("confirm-character-import", confirmCharacterImport);
  ipcMain.handle("remove-character-import", removeCharacterImport);
  ipcMain.handle("begin-speech", beginSpeech);
  ipcMain.on("speech-state-changed", speechStateChanged);
  ipcMain.handle("stop-voice", stopVoice);
  ipcMain.handle("replay-speech", replaySpeech);
  ipcMain.handle("synthesize-speech", synthesizeSpeech);
  ipcMain.on("set-settings", (_event, patch) => updateSettings(patch));
  ipcMain.on("record-interaction", (_event, kind) => { lastUserActivityAt = Date.now(); updateMoodFromInteraction(kind); });
  ipcMain.on("present-notification", (event, notice) => {
    if (event.sender !== mainWindow?.webContents || !Notification.isSupported()) return;
    const title = normalizeCompactText(notice?.title, 120);
    const body = normalizeLongText(notice?.body, 600);
    if (title || body) new Notification({ title, body, silent: true }).show();
  });
  ipcMain.on("open-chat-window", createChatWindow);
  ipcMain.on("open-quick-chat-window", createQuickChatWindow);
  ipcMain.on("open-companion-settings", createCompanionSettingsWindow);
  ipcMain.on("show-context-menu", showContextMenu);
  ipcMain.on("drag-start", beginDrag);
  ipcMain.handle("drag-move", moveDrag);
  ipcMain.on("drag-end", endDrag);

  if (process.platform === "darwin") {
    app.dock.hide();
  }

  setApplicationMenu();

  try {
    mainWindow.setIcon?.(iconImage());
  } catch {
    // Window icons are platform-dependent; failing to set one should not block the pet.
  }

  scheduleRestReminder();
  scheduleAutonomousConversation();
  maybeShowInitialPersonaSettings();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { app.isQuitting = true; clearTimeout(autonomousTimer); autonomousTimer = null; speechSession?.controller?.abort(); });
