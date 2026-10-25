const canvas = document.querySelector("#pet");
const speechBubble = document.querySelector("#speech-bubble");
const talkButton = document.querySelector("#talk");
const ctx = canvas.getContext("2d", { alpha: true });
const i18n = window.DesktopPetI18n;
const SINGLE_CLICK_DELAY = 280;
const CLICK_ONLY_COOLDOWN = 220;

const FALLBACK_CHARACTER = {
  id: "default",
  name: "Default Character",
  spritePath: "../assets/characters/default/sprite.png",
  frame: { width: 768, height: 832 },
  columns: 8,
  states: {
    idle: { row: 0, frames: 6, interval: 900 },
    runningRight: { row: 1, frames: 8, interval: 100 },
    runningLeft: { row: 2, frames: 8, interval: 100 },
    waving: { row: 3, frames: 4, interval: 160 },
    jumping: { row: 4, frames: 5, interval: 140 },
    failed: { row: 5, frames: 8, interval: 220 },
    running: { row: 6, frames: 6, interval: 100 },
    review: { row: 7, frames: 6, interval: 500 },
  },
  automaticActions: ["review", "review", "waving", "jumping"],
  clickActions: ["waving", "review", "jumping", "failed"],
  staticExpressions: [
    { state: "idle", frame: 0 },
    { state: "idle", frame: 1 },
    { state: "idle", frame: 2 },
    { state: "idle", frame: 3 },
    { state: "idle", frame: 5 },
    { state: "waving", frame: 2 },
    { state: "review", frame: 1 },
    { state: "review", frame: 4 },
    { state: "failed", frame: 1 },
    { state: "failed", frame: 4 },
  ],
};

let settings = {
  language: "system",
  resolvedLanguage: "zh-CN",
  personaMode: "normal",
  animationMode: "normal",
  cegilLocked: false,
  expressionMode: "automatic",
  interactionResponses: true,
  userName: "",
  scale: 1,
  alwaysOnTop: true,
  tts: { enabled: false, provider: "none", voiceName: "", rate: 1, pitch: 1, volume: 1 },
};
let character = FALLBACK_CHARACTER;
let spriteImage;
let animationFrameImages = {};
let state = "idle";
let frameIndex = 0;
let animationTimer;
let animationRaf = 0;
let animationGeneration = 0;
let streamedFrameCache = new Map();
let failedStreamedFrames = new Set();
let streamedFrameGeneration = 0;
const STREAMED_FRAME_CACHE_LIMIT = 10;
let idleFrameClock = 0;
let idleTimer;
let idleScheduleGeneration = 0;
let temporaryToken = 0;
let temporaryAnimationActive = false;
let clickExpressionIndex = 0;
let dragInterval;
let dragStart = null;
let didDrag = false;
let clickTimer;
let clickOnlyReadyAt = 0;
let ignoreSingleClicksUntil = 0;
let hoverReadyAt = 0;
let bubbleTimer;
let didShowStartupGreeting = false;
let didPlayStartupVoiceGreeting = false;
let activeLanguage = "zh-CN";
let spriteLoadToken = 0;
let speechToken = 0;
let speechGeneration = 0;
let speechId = null;
let activeAudio = null;
let speechActive = false;
let fishAudioPlaying = false;
let manualCegilUntil = 0;
let speechWatchdog;
let conversationActive = false;
let voiceLineAudio = null;
let voiceLineIdleTimer = null;
let voiceLineLastInteraction = 0;
let clickVoiceReadyAt = 0;
let voiceLineRequestToken = 0;
let chatRequestActive = false;
let conversationAction = "idle";
let musicModeEnabled = false;
let queuedNotice = null;
let bubbleVisible = false;
let interactionReadyAt = 0;
let interactionVariants = { head: 0, greet: 0, drop: 0 };
let clickReactionSequenceAt = 0;
let clickReactionSequenceCount = 0;
let pendingDoubleClickSequenceCount = 0;
let clickReactionBubbleVisible = false;

function text(key, variables = {}) {
  return i18n.t(key, variables, activeLanguage);
}

function isCegilAnimationMode() {
  return (settings.animationMode === "cegil" || (!settings.animationMode && settings.personaMode === "cegil")) && character.id === "rem";
}

function isAnimationMode() {
  return settings.animationMode === "animation";
}

function activeAnimationAsset() {
  const assets = character.animationAssets || {};
  if (settings.cegilLocked || performance.now() < manualCegilUntil) return assets.cegil || assets.idle;
  if (fishAudioPlaying) return assets.speak || assets.idle;
  return assets.idle;
}

function clearStreamedFrameCache() {
  streamedFrameGeneration += 1;
  streamedFrameCache.forEach((entry) => { if (entry.image) entry.image.removeAttribute("src"); });
  streamedFrameCache.clear();
  failedStreamedFrames.clear();
}

function drawCegilFallback() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const loadedEntries = [...streamedFrameCache.values()].filter((entry) => entry.loaded);
  const fallback = loadedEntries[loadedEntries.length - 1]?.image;
  if (!fallback) return;
  const scale = Math.min(canvas.width / fallback.naturalWidth, canvas.height / fallback.naturalHeight);
  const width = fallback.naturalWidth * scale;
  const height = fallback.naturalHeight * scale;
  ctx.drawImage(fallback, (canvas.width - width) / 2, canvas.height - height, width, height);
}

function draw() {
  if (isAnimationMode()) {
    const current = activeAnimationAsset();
    if (!current?.framePaths?.length) { ctx.clearRect(0, 0, canvas.width, canvas.height); console.error("[animation] Mode Animasi asset unavailable", current); return; }
    const framePath = current.framePaths[frameIndex % current.frames];
    const entry = streamedFrameCache.get(framePath);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!entry?.loaded) { requestStreamedFrame(framePath); preloadStreamedFrames(current, frameIndex); return; }
    const image = entry.image;
    streamedFrameCache.delete(framePath); streamedFrameCache.set(framePath, entry);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    ctx.drawImage(image, (canvas.width - width) / 2, canvas.height - height, width, height);
    preloadStreamedFrames(current, frameIndex);
    return;
  }
  const cegilMode = isCegilAnimationMode();
  if (!spriteImage && !cegilMode) return;
  let current = cegilMode ? character.cegilIdle : character.states[state];
  let activeState = state;
  const frame = character.frame;
  const validState = (candidate) => candidate
    && Number.isInteger(candidate.frames) && candidate.frames > 0
    && (Array.isArray(candidate.framePaths)
      ? candidate.framePaths.length === candidate.frames
        && (candidate.streamed === true || animationFrameImages[activeState]?.length === candidate.frames)
      : Number.isInteger(candidate.row) && candidate.row >= 0)
    && (Array.isArray(candidate.framePaths) || candidate.frames <= character.columns)
    && (!candidate.frameIndices || (Array.isArray(candidate.frameIndices)
      && candidate.frameIndices.length === candidate.frames
      && candidate.frameIndices.every((index) => Number.isInteger(index) && index >= 0 && index < character.columns)))
    && (Array.isArray(candidate.framePaths)
      || (spriteImage && candidate.row * frame.height + frame.height <= spriteImage.naturalHeight
        && candidate.frames * frame.width <= spriteImage.naturalWidth));
  if (!validState(current)) {
    if (cegilMode) {
      drawCegilFallback();
      return;
    }
    activeState = "idle";
    current = character.states.idle;
  }
  if (!validState(current)) return;
  if (activeState !== state) {
    state = activeState;
    frameIndex = 0;
  }
  const activeFrame = Math.min(frameIndex, current.frames - 1);
  if (Array.isArray(current.framePaths)) {
    const framePath = current.framePaths[activeFrame];
    if (current.streamed === true) {
      if (failedStreamedFrames.has(framePath)) {
        drawCegilFallback();
        return;
      }
      const entry = streamedFrameCache.get(framePath);
      if (!entry?.loaded) {
        requestStreamedFrame(framePath);
        preloadStreamedFrames(current, activeFrame);
        return;
      }
      const image = entry.image;
      streamedFrameCache.delete(framePath);
      streamedFrameCache.set(framePath, entry);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      ctx.drawImage(image, (canvas.width - width) / 2, canvas.height - height, width, height);
      preloadStreamedFrames(current, activeFrame);
      return;
    }
    const image = animationFrameImages[activeState]?.[activeFrame];
    if (!image) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    ctx.drawImage(image, (canvas.width - width) / 2, canvas.height - height, width, height);
    return;
  }
  const sheetColumn = current.frameIndices?.[activeFrame] ?? activeFrame;
  const sx = sheetColumn * frame.width;
  const sy = current.row * frame.height;
  if (sx + frame.width > spriteImage.naturalWidth || sy + frame.height > spriteImage.naturalHeight) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const bounds = character.frameBounds?.[activeState]?.[activeFrame];
  if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger)
    && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
    && bounds.x + bounds.width <= frame.width && bounds.y + bounds.height <= frame.height) {
    // The new Rem rows have transparent padding that varies from frame to
    // frame. Crop to the measured alpha bounds, preserve aspect ratio, center
    // the visible character, and anchor its feet to a shared baseline.
    const drawHeight = canvas.height;
    const drawWidth = bounds.width * drawHeight / bounds.height;
    ctx.drawImage(spriteImage,
      sx + bounds.x, sy + bounds.y, bounds.width, bounds.height,
      (canvas.width - drawWidth) / 2, canvas.height - drawHeight, drawWidth, drawHeight);
    return;
  }
  const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  ctx.drawImage(spriteImage, sx, sy, frame.width, frame.height,
    (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function applyPetLayout() {
  const petWidth = Math.round(192 * settings.scale);
  const petHeight = Math.round(208 * settings.scale);
  document.documentElement.style.setProperty("--pet-width", `${petWidth}px`);
  document.documentElement.style.setProperty("--pet-height", `${petHeight}px`);
}

function startAnimation() {
  window.clearInterval(animationTimer);
  if (animationRaf) cancelAnimationFrame(animationRaf);
  animationRaf = 0;
  const generation = ++animationGeneration;
  if (isAnimationMode()) {
    frameIndex = 0;
    if (!activeAnimationAsset()?.framePaths?.length) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      console.error("[animation] Mode Animasi asset unavailable for the selected character");
      return;
    }
    const tick = (now) => {
      if (generation !== animationGeneration || !isAnimationMode() || document.hidden) { animationRaf = 0; return; }
      const current = activeAnimationAsset();
      if (!current?.framePaths?.length) { ctx.clearRect(0, 0, canvas.width, canvas.height); animationRaf = requestAnimationFrame(tick); return; }
      if (tick.asset !== current) { tick.asset = current; tick.last = now; frameIndex = 0; draw(); }
      if (now - tick.last >= current.interval) {
        const steps = Math.max(1, Math.floor((now - tick.last) / current.interval));
        frameIndex = (frameIndex + steps) % current.frames;
        tick.last += steps * current.interval;
        draw();
      }
      animationRaf = requestAnimationFrame(tick);
    };
    draw();
    animationRaf = requestAnimationFrame(tick);
    return;
  }
  const cegilMode = isCegilAnimationMode();
  const current = cegilMode ? character.cegilIdle : (character.states[state] || character.states.idle);
  if (document.hidden) return;
  if (cegilMode) {
    state = "idle";
    if (!current?.streamed || !Array.isArray(current.framePaths) || !current.framePaths.length) {
      drawCegilFallback();
      console.warn("[animation] mode=cegil source=fallback reason=sequence-unavailable; mode remains cegil");
      return;
    }
    idleFrameClock = performance.now();
    const interval = 1000 / 12;
    const tick = (now) => {
      if (generation !== animationGeneration || !isCegilAnimationMode() || document.hidden) { animationRaf = 0; return; }
      const elapsed = now - idleFrameClock;
      if (elapsed >= interval) {
        const steps = Math.max(1, Math.floor(elapsed / interval));
        frameIndex = (frameIndex + steps) % current.frames;
        idleFrameClock += steps * interval;
        draw();
      }
      animationRaf = requestAnimationFrame(tick);
    };
    draw();
    preloadStreamedFrames(current, frameIndex);
    animationRaf = requestAnimationFrame(tick);
    return;
  }
  animationTimer = window.setInterval(() => {
    if (generation !== animationGeneration || isCegilAnimationMode()) return;
    if (settings.expressionMode === "clickOnly" && !dragStart && !speechActive && !musicModeEnabled && !temporaryAnimationActive) {
      draw();
      return;
    }
    // Keep the current expression animated while TTS is playing; hold its last
    // frame after speech in automatic mode so the conversation remains readable.
    frameIndex = conversationActive && state === conversationAction && !speechActive && current.loop !== true
      ? Math.min(frameIndex + 1, current.frames - 1)
      : (frameIndex + 1) % current.frames;
    draw();
  }, current.interval);
  draw();
}

function setState(nextState) {
  if (isAnimationMode()) return;
  if (isCegilAnimationMode()) {
    if (nextState !== "idle") console.debug(`[animation] mode=cegil source=sequence reason=ignored-state-request:${nextState}`);
    return;
  }
  if (musicModeEnabled && character.states.listening_music) nextState = "listening_music";
  if (!character.states[nextState]) nextState = "idle";
  if (state === nextState) return;
  console.debug(`[animation] mode=normal source=character-state state=${nextState}`);
  state = nextState;
  frameIndex = 0;
  startAnimation();
}

function scheduleIdleBehavior() {
  window.clearTimeout(idleTimer);
  const generation = ++idleScheduleGeneration;
  if (isCegilAnimationMode() || isAnimationMode() || settings.expressionMode !== "automatic" || conversationActive) return;

  const delay = 22000 + Math.random() * 15000;
  idleTimer = window.setTimeout(() => {
    if (generation !== idleScheduleGeneration || isCegilAnimationMode()) return;
    if (state === "idle" && !conversationActive) {
      const choices = character.automaticActions.length > 0
        ? character.automaticActions
        : FALLBACK_CHARACTER.automaticActions;
      playTemporary(choices[Math.floor(Math.random() * choices.length)], 1200);
    }
    scheduleIdleBehavior();
  }, delay);
}

function temporaryDuration(nextState) {
  if (nextState === "waving") return 1000;
  if (nextState === "failed") return 1700;
  if (nextState === "review") return 1400;
  return 1100;
}

function playTemporary(nextState, duration = temporaryDuration(nextState)) {
  if (isCegilAnimationMode() || isAnimationMode()) return;
  if (!character.states[nextState]) return;
  window.clearTimeout(idleTimer);
  temporaryToken += 1;
  const token = temporaryToken;
  temporaryAnimationActive = true;
  setState(nextState);
  window.setTimeout(() => {
    if (temporaryToken !== token) return;
    temporaryAnimationActive = false;
    if (didDrag) return;
    setState(conversationActive ? conversationAction : "idle");
    scheduleIdleBehavior();
  }, duration);
}

function applyExpressionRequest(request = {}) {
  if (isCegilAnimationMode() || isAnimationMode()) return;
  const requested = request.state;
  if (requested === "listening_music") {
    musicModeEnabled = request.enabled === true;
    setState(musicModeEnabled ? "listening_music" : (conversationActive ? conversationAction : "idle"));
    return;
  }
  if (!["tsundere", "angry"].includes(requested) || !character.states[requested]) return;
  playTemporary(requested, requested === "angry" ? 2400 : 3000);
}

function nextClickState() {
  const states = character.clickActions.length > 0 ? character.clickActions : FALLBACK_CHARACTER.clickActions;
  const nextState = states[clickExpressionIndex % states.length];
  clickExpressionIndex += 1;
  return nextState;
}

function nextStaticExpression() {
  const expressions = character.staticExpressions.length > 0
    ? character.staticExpressions
    : FALLBACK_CHARACTER.staticExpressions;
  const expression = expressions[clickExpressionIndex % expressions.length];
  clickExpressionIndex += 1;
  return [expression.state, expression.frame];
}

function setStaticExpression(nextState, nextFrame) {
  if (isAnimationMode()) return;
  if (isCegilAnimationMode()) return;
  if (!character.states[nextState]) return;
  window.clearTimeout(idleTimer);
  temporaryToken += 1;
  state = nextState;
  frameIndex = Math.min(Math.max(0, nextFrame), character.states[nextState].frames - 1);
  console.debug(`[animation] mode=normal source=static-expression state=${nextState} frame=${frameIndex}`);
  startAnimation();
  draw();
}

function normalizeCharacter(nextCharacter) {
  const merged = { ...FALLBACK_CHARACTER, ...(nextCharacter || {}) };
  merged.frame = { ...FALLBACK_CHARACTER.frame, ...(nextCharacter?.frame || {}) };
  merged.states = nextCharacter?.states || FALLBACK_CHARACTER.states;
  merged.cegilIdle = nextCharacter?.cegilIdle || null;
  merged.animationAssets = nextCharacter?.animationAssets || {};
  merged.automaticActions = Array.isArray(nextCharacter?.automaticActions)
    ? nextCharacter.automaticActions
    : FALLBACK_CHARACTER.automaticActions;
  merged.clickActions = Array.isArray(nextCharacter?.clickActions)
    ? nextCharacter.clickActions
    : FALLBACK_CHARACTER.clickActions;
  merged.staticExpressions = Array.isArray(nextCharacter?.staticExpressions)
    ? nextCharacter.staticExpressions
    : FALLBACK_CHARACTER.staticExpressions;
  return merged;
}

function applyAppState(nextAppState = {}) {
  if (Number.isFinite(nextAppState.speechGeneration)) speechGeneration = Math.max(speechGeneration, nextAppState.speechGeneration);
  const nextCharacter = normalizeCharacter(nextAppState.activeCharacter);
  const characterChanged = nextCharacter.id !== character.id;
  const previousPersonaMode = settings.personaMode === "cegil" ? "cegil" : "normal";
  const nextPersonaMode = nextAppState.settings?.personaMode === "cegil" ? "cegil" : "normal";
  const personaModeChanged = nextPersonaMode !== previousPersonaMode;
  const previousAnimationMode = settings.animationMode || previousPersonaMode;
  const nextAnimationMode = ["normal", "cegil", "animation"].includes(nextAppState.settings?.animationMode)
    ? nextAppState.settings.animationMode : nextPersonaMode;
  const animationModeChanged = nextAnimationMode !== previousAnimationMode;
  const expressionModeChanged = nextAppState.settings?.expressionMode !== settings.expressionMode;
  const voiceLinesWereEnabled = settings.voiceLines?.enabled === true;
  const previousTts = JSON.stringify(settings.tts);
  const previousMusicMode = musicModeEnabled;
  const previousCegilLocked = settings.cegilLocked === true;
  musicModeEnabled = nextAppState.musicModeEnabled === true;
  character = nextCharacter;
  settings = {
    language: nextAppState.settings?.language || nextAppState.language || "system",
    resolvedLanguage: nextAppState.resolvedLanguage || nextAppState.settings?.resolvedLanguage || "zh-CN",
    characterId: nextAppState.settings?.characterId || character.id,
    personaMode: nextPersonaMode,
    animationMode: nextAnimationMode,
    cegilLocked: nextAppState.settings?.cegilLocked === true,
    expressionMode: nextAppState.settings?.expressionMode === "clickOnly" ? "clickOnly" : "automatic",
    interactionResponses: nextAppState.settings?.interactionResponses !== false,
    userName: nextAppState.settings?.persona?.userName || "",
    scale: Number(nextAppState.settings?.scale) || 1,
    alwaysOnTop: nextAppState.settings?.alwaysOnTop !== false,
    voiceLines: {
      enabled: nextAppState.settings?.voiceLines?.enabled === true,
      volume: Math.min(Math.max(Number(nextAppState.settings?.voiceLines?.volume ?? 0.7), 0), 1),
      idleVoiceEnabled: nextAppState.settings?.voiceLines?.idleVoiceEnabled === true,
      idleIntervalMinSeconds: Math.min(Math.max(Number(nextAppState.settings?.voiceLines?.idleIntervalMinSeconds) || 30, 30), 60),
      idleIntervalMaxSeconds: Math.min(Math.max(Number(nextAppState.settings?.voiceLines?.idleIntervalMaxSeconds) || 60, 30), 60),
      playGreetingOnStartup: nextAppState.settings?.voiceLines?.playGreetingOnStartup === true,
      startupGreetingClickFallback: nextAppState.settings?.voiceLines?.startupGreetingClickFallback === true,
      clickCategories: Array.isArray(nextAppState.settings?.voiceLines?.clickCategories) ? nextAppState.settings.voiceLines.clickCategories : [nextAppState.settings?.voiceLines?.clickCategory || "Interactive Conversation", "Funny Reactions"],
      idleCategories: Array.isArray(nextAppState.settings?.voiceLines?.idleCategories) ? nextAppState.settings.voiceLines.idleCategories : [nextAppState.settings?.voiceLines?.idleCategory || "Daily Conversation", "Work & Study"],
      greetingCategory: nextAppState.settings?.voiceLines?.greetingCategory || "Greeting",
      nightCategory: nextAppState.settings?.voiceLines?.nightCategory || "Night",
      nightEnabled: nextAppState.settings?.voiceLines?.nightEnabled === true,
      nightStart: nextAppState.settings?.voiceLines?.nightStart || "22:00",
      nightEnd: nextAppState.settings?.voiceLines?.nightEnd || "05:00",
    },
    tts: {
      enabled: nextAppState.settings?.tts?.enabled === true,
      provider: typeof nextAppState.settings?.tts?.provider === "string"
        ? nextAppState.settings.tts.provider
        : "none",
      voiceName: typeof nextAppState.settings?.tts?.voiceName === "string"
        ? nextAppState.settings.tts.voiceName
        : "",
      rate: Number(nextAppState.settings?.tts?.rate) || 1,
      pitch: Number(nextAppState.settings?.tts?.pitch) || 1,
      volume: Math.min(Math.max(Number(nextAppState.settings?.tts?.volume ?? 1), 0), 1),
    },
  };
  if (voiceLinesWereEnabled && !settings.voiceLines.enabled) stopVoiceLine();
  if (characterChanged) {
    interactionReadyAt = 0;
    interactionVariants = { head: 0, greet: 0, drop: 0 };
    clearPresentation();
    temporaryAnimationActive = false;
  }
  else if (previousTts !== JSON.stringify(settings.tts)) {
    stopSpeech();
    if (bubbleVisible) hideBubbleLater(Math.max(3000, bubbleRemaining));
  }
  activeLanguage = settings.resolvedLanguage;
  scheduleIdleVoiceLine();
  talkButton.textContent = text("pet.talk");
  talkButton.title = text("quick.toCharacter", { name: character.name });
  document.documentElement.lang = activeLanguage;
  applyPetLayout();

  if (characterChanged || !spriteImage) {
    const token = ++spriteLoadToken;
    temporaryToken += 1;
    animationGeneration += 1;
    window.clearInterval(animationTimer);
    if (animationRaf) cancelAnimationFrame(animationRaf);
    animationRaf = 0;
    window.clearTimeout(idleTimer);
    idleScheduleGeneration += 1;
    spriteImage = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    clearStreamedFrameCache();
    const framePaths = Object.values(character.states || {}).flatMap((descriptor) => descriptor.streamed === true ? [] : (descriptor.framePaths || []));
    const uniqueFramePaths = [...new Set(framePaths)];
    const applyLoadedSprites = (image, frameImages) => {
      if (token !== spriteLoadToken) return;
      spriteImage = image;
      const frameImagesByPath = new Map(uniqueFramePaths.map((framePath, index) => [framePath, frameImages[index]]));
      animationFrameImages = Object.fromEntries(Object.entries(character.states)
        .filter(([, descriptor]) => Array.isArray(descriptor.framePaths))
        .map(([name, descriptor]) => [name, descriptor.framePaths.map((framePath) => frameImagesByPath.get(framePath))]));
      resetAfterSettingsChange();
    };
    if (uniqueFramePaths.length) {
      const mayDegradeToCegil = isCegilAnimationMode();
      const spritePaths = [character.spritePath, ...uniqueFramePaths];
      const spriteLoads = spritePaths.map((spritePath) => loadSprite(spritePath));
      const settledLoads = mayDegradeToCegil
        ? spriteLoads.map((load, index) => load.catch((error) => {
          console.error("[animation] mode=cegil source=fallback reason=optional-sprite-load-failed", spritePaths[index], error);
          return null;
        }))
        : spriteLoads;
      Promise.all(settledLoads)
        .then(([image, ...frameImages]) => applyLoadedSprites(image, frameImages))
        .catch((error) => {
          if (token === spriteLoadToken) console.error("Unable to load character sprite", error);
        });
    } else {
      loadSprite(character.spritePath)
        .then((image) => applyLoadedSprites(image, []))
        .catch((error) => {
          if (!isCegilAnimationMode() || token !== spriteLoadToken) {
            if (token === spriteLoadToken) console.error("Unable to load character sprite", error);
            return;
          }
          console.error("[animation] mode=cegil source=fallback reason=optional-sprite-load-failed", character.spritePath, error);
          applyLoadedSprites(null, []);
        })
    }
    return;
  }

  if (animationModeChanged) applyAnimationModeChange(previousAnimationMode, settings.animationMode);
  else if (personaModeChanged && !isAnimationMode()) applyPersonaModeChange(previousPersonaMode, settings.personaMode);
  else if (isAnimationMode() && previousCegilLocked !== settings.cegilLocked) startAnimation();
  else if (expressionModeChanged && !isCegilAnimationMode()) resetAfterSettingsChange();
  else if (!isCegilAnimationMode() && previousMusicMode !== musicModeEnabled) {
    if (settings.expressionMode === "automatic" || musicModeEnabled) {
      setState(musicModeEnabled ? "listening_music" : (conversationActive ? conversationAction : "idle"));
    }
  }
}

function applyAnimationModeChange(previousMode, nextMode) {
  console.info(`[animation] mode=${nextMode} source=animation-setting reason=mode-change from=${previousMode}`);
  window.clearInterval(animationTimer);
  if (animationRaf) cancelAnimationFrame(animationRaf);
  animationRaf = 0;
  animationGeneration += 1;
  window.clearTimeout(idleTimer);
  idleScheduleGeneration += 1;
  temporaryToken += 1;
  temporaryAnimationActive = false;
  manualCegilUntil = 0;
  clearStreamedFrameCache();
  frameIndex = 0;
  state = "idle";
  if (isAnimationMode()) startAnimation();
  else if (isCegilAnimationMode()) startAnimation();
  else resetAfterSettingsChange();
}

function applyPersonaModeChange(previousMode, nextMode) {
  console.info(`[animation] mode=${nextMode} source=persona-setting reason=mode-change from=${previousMode}`);
  window.clearInterval(animationTimer);
  if (animationRaf) cancelAnimationFrame(animationRaf);
  animationRaf = 0;
  animationGeneration += 1;
  window.clearTimeout(idleTimer);
  idleScheduleGeneration += 1;
  temporaryToken += 1;
  temporaryAnimationActive = false;
  clearStreamedFrameCache();
  frameIndex = 0;
  state = "idle";
  if (isCegilAnimationMode()) {
    startAnimation();
    scheduleIdleBehavior();
  } else {
    resetAfterSettingsChange();
  }
}

function resetAfterSettingsChange() {
  window.clearTimeout(clickTimer);
  ignoreSingleClicksUntil = 0;
  clickOnlyReadyAt = 0;
  cancelDrag();
  temporaryToken += 1;
  temporaryAnimationActive = false;
  state = isCegilAnimationMode() ? "idle" : (musicModeEnabled && character.states.listening_music ? "listening_music" : "idle");
  frameIndex = 0;
  if (isAnimationMode()) {
    startAnimation();
  } else if (isCegilAnimationMode()) {
    startAnimation();
    scheduleIdleBehavior();
  } else if (settings.expressionMode === "clickOnly" && !musicModeEnabled) {
    console.info(`[animation] mode=normal source=character-state reason=settings-reset state=idle expressionMode=${settings.expressionMode}`);
    window.clearTimeout(idleTimer);
    const currentIndex = character.staticExpressions.findIndex((expression) => expression.state === "idle" && expression.frame === 0);
    clickExpressionIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    setStaticExpression("idle", 0);
  } else {
    console.info(`[animation] mode=normal source=character-state reason=settings-reset state=${state} expressionMode=${settings.expressionMode}`);
    startAnimation();
    if (conversationActive && !dragStart) setState(conversationAction);
    scheduleIdleBehavior();
  }
  scheduleStartupGreeting();
  if (!didPlayStartupVoiceGreeting && settings.voiceLines?.playGreetingOnStartup) {
    didPlayStartupVoiceGreeting = true;
    let attempts = 0;
    const tryStartupVoiceGreeting = async () => {
      if (!settings.voiceLines?.playGreetingOnStartup || attempts >= 3) return;
      attempts += 1;
      if (voiceLineAudio) { window.setTimeout(tryStartupVoiceGreeting, 1000); return; }
      const greetingCategory = allowedVoiceCategories([settings.voiceLines.greetingCategory]);
      const played = await playVoiceLine(greetingCategory, false);
      if (!played && attempts < 3) {
        const hasGreeting = greetingCategory.length ? await window.desktopPet.getRandomVoiceLine(greetingCategory).catch(() => null) : null;
        if (!hasGreeting?.ok && settings.voiceLines?.startupGreetingClickFallback) {
          const fallbackPlayed = await playVoiceLine(settings.voiceLines.clickCategories, false);
          if (fallbackPlayed) return;
        }
        window.setTimeout(tryStartupVoiceGreeting, 1000);
      }
    };
    window.setTimeout(tryStartupVoiceGreeting, 700);
  }
}

function respondToInteraction(kind, sequenceCount = 1, clickReaction = false) {
  if (settings.expressionMode !== "automatic" || !settings.interactionResponses
    || conversationActive || speechActive) return;
  const playfulAnnoyance = sequenceCount === 5 && Math.random() < 0.3;
  const choices = playfulAnnoyance && character.states.angry ? ["angry"]
    : sequenceCount >= 3 && character.states.tsundere ? ["tsundere", "review", "waving"]
      : kind === "head" ? ["shy", "happy", "review", "idle"]
        : kind === "drop" ? ["tsundereProud", "happy", "waving", "idle"] : ["waving", "happy", "idle"];
  const availableChoices = choices.filter((name) => character.states[name]);
  const action = availableChoices.length
    ? (sequenceCount < 3 ? availableChoices[0] : availableChoices[(sequenceCount - 1) % availableChoices.length])
    : "idle";
  if (action) playTemporary(action, action === "angry" ? 1600 : 1400);
  const milestone = clickReaction && sequenceCount >= 5 && sequenceCount % 5 === 0;
  // Preserve active chat/reminder bubbles; allow a five or ten click milestone
  // to update the bubble generated by the previous local click reaction.
  const now = performance.now();
  if (bubbleVisible && !(milestone && clickReactionBubbleVisible)) return "";
  if (clickReaction) {
    if (now < clickReactionBubbleReadyAt && !milestone) return "";
    clickReactionBubbleReadyAt = now + 650;
  } else {
    if (now < interactionReadyAt) return "";
    interactionReadyAt = now + 6000;
  }
  const style = character.id === "luna" ? "luna" : "default";
  const variant = interactionVariants[kind]++ % 2;
  const line = musicModeEnabled
    ? text(`pet.interaction.${style}.music.${sequenceCount % 2}`)
    : sequenceCount >= 3
      ? text(`pet.interaction.${style}.tap.${(sequenceCount - 3) % 2}`)
      : text(`pet.interaction.${style}.${kind}.${variant}`);
  showBubble(settings.userName ? text("pet.interaction.address", { name: settings.userName, line }) : line);
  clickReactionBubbleVisible = clickReaction;
  return line;
}

function registerClickSequence() {
  const now = Date.now();
  // Keep a burst alive long enough for a short voice clip to finish between taps.
  clickReactionSequenceCount = now - clickReactionSequenceAt > 30_000 ? 1 : clickReactionSequenceCount + 1;
  clickReactionSequenceAt = now;
  return clickReactionSequenceCount;
}

function isClickMilestone(count) {
  return count >= 5 && count % 5 === 0;
}

function requestClickMilestone(kind, count) {
  if (!isClickMilestone(count) || conversationActive || speechActive) return;
  if (settings.expressionMode === "clickOnly" || !settings.interactionResponses) {
    if (bubbleVisible && !clickReactionBubbleVisible) return;
    const style = character.id === "luna" ? "luna" : "default";
    const line = text(`pet.interaction.${style}.${musicModeEnabled ? "music" : "tap"}.${count % 2}`);
    showBubble(line);
    clickReactionBubbleVisible = true;
  }
  // Replace any click voice clip still playing with the single contextual AI reply.
  stopVoiceLine();
  clickVoiceReadyAt = Date.now() + 1400;
  const request = window.desktopPet.reactToClick?.(kind, count);
  if (!request || typeof request.then !== "function") return;
  void request.then((result) => {
    if (result?.ok) {
      if ((!settings.tts?.enabled || settings.tts.provider === "none") && settings.voiceLines?.enabled) {
        void playVoiceLine(allowedVoiceCategories(settings.voiceLines.clickCategories), true);
      }
      return;
    }
    if (conversationActive || speechActive) return;
    // If AI is unavailable, retain a voiced reaction using the existing clip library.
    if (settings.voiceLines?.enabled) void playVoiceLine(allowedVoiceCategories(settings.voiceLines.clickCategories), true);
  }).catch(() => {
    if (!conversationActive && !speechActive && settings.voiceLines?.enabled) {
      void playVoiceLine(allowedVoiceCategories(settings.voiceLines.clickCategories), true);
    }
  });
}

function handleClick(kind = "greet", recordInteraction = true, registeredSequenceCount = null) {
  if (recordInteraction) window.desktopPet.recordInteraction("click");
  const now = Date.now();
  const sequenceCount = Number.isInteger(registeredSequenceCount) ? registeredSequenceCount : registerClickSequence();
  voiceLineLastInteraction = now;
  if (sequenceCount === 1 && !conversationActive && !speechActive && !voiceLineAudio && now >= clickVoiceReadyAt) {
    clickVoiceReadyAt = now + 1400;
    playVoiceLine(allowedVoiceCategories(settings.voiceLines?.clickCategories), true);
  }
  if (settings.expressionMode === "clickOnly") {
    const [nextState, nextFrame] = nextStaticExpression();
    setStaticExpression(nextState, nextFrame);
    requestClickMilestone(kind, sequenceCount);
  } else {
    if (conversationActive || speechActive) return;
    if (settings.interactionResponses) {
      respondToInteraction(kind, sequenceCount, true);
      requestClickMilestone(kind, sequenceCount);
      return;
    }
    const nextState = nextClickState();
    playTemporary(nextState);
    requestClickMilestone(kind, sequenceCount);
  }
}

function handleDoubleClick() {
  window.clearTimeout(clickTimer);
  ignoreSingleClicksUntil = performance.now() + 360;
  if (settings.expressionMode === "clickOnly") {
    voiceLineLastInteraction = Date.now();
    if (!voiceLineAudio) playVoiceLine(allowedVoiceCategories(settings.voiceLines?.clickCategories), true);
    if (isClickMilestone(pendingDoubleClickSequenceCount) && settings.voiceLines?.enabled) playVoiceLine(allowedVoiceCategories(settings.voiceLines.clickCategories), true);
    pendingDoubleClickSequenceCount = 0;
    return;
  }
  if (conversationActive || speechActive) return;
  if (settings.interactionResponses) {
    window.desktopPet.recordInteraction("doubleClick");
    const sequenceCount = pendingDoubleClickSequenceCount || null;
    pendingDoubleClickSequenceCount = 0;
    handleClick("greet", false, sequenceCount);
    return;
  }
  voiceLineLastInteraction = Date.now();
  if (!voiceLineAudio) playVoiceLine(allowedVoiceCategories(settings.voiceLines?.clickCategories), true);
  if (isClickMilestone(pendingDoubleClickSequenceCount) && settings.voiceLines?.enabled) playVoiceLine(allowedVoiceCategories(settings.voiceLines.clickCategories), true);
  pendingDoubleClickSequenceCount = 0;
  window.desktopPet.recordInteraction("doubleClick");
  playTemporary("jumping", 1200);
}

function handleLongPress() {
  window.clearTimeout(clickTimer);
  if (settings.expressionMode === "clickOnly" || conversationActive || speechActive) return;
  window.desktopPet.recordInteraction("longPress");
  if (settings.interactionResponses) {
    respondToInteraction("head");
  } else {
    playTemporary("review", 1400);
  }
}

function scheduleSingleClick(kind, sequenceCount = null) {
  window.clearTimeout(clickTimer);
  const scheduledAt = performance.now();
  clickTimer = window.setTimeout(() => {
    if (scheduledAt < ignoreSingleClicksUntil) return;
    handleClick(kind, true, sequenceCount);
  }, SINGLE_CLICK_DELAY);
}

function handleClickOnlyPointerClick(sequenceCount = null) {
  const now = performance.now();
  if (now < clickOnlyReadyAt) {
    requestClickMilestone("greet", sequenceCount);
    return;
  }
  clickOnlyReadyAt = now + CLICK_ONLY_COOLDOWN;
  handleClick("greet", true, sequenceCount);
}

function beginDrag(event) {
  voiceLineLastInteraction = Date.now();
  if (event.button !== 0) return;
  window.clearTimeout(clickTimer);
  const bounds = canvas.getBoundingClientRect();
  dragStart = {
    x: event.screenX,
    y: event.screenY,
    time: performance.now(),
    kind: (event.clientY - bounds.top) / bounds.height < 0.46 ? "head" : "greet",
    expression: { state, frame: frameIndex },
  };
  didDrag = false;
  canvas.classList.add("dragging");
  window.desktopPet.dragStart();
  window.clearInterval(dragInterval);
  dragInterval = window.setInterval(async () => {
    if (!dragStart) return;
    const activeDrag = dragStart;
    let movement;
    try {
      movement = await window.desktopPet.dragMove();
    } catch {
      return;
    }
    if (dragStart !== activeDrag) return;
    if (Math.abs(movement.dx) > 2 || Math.abs(movement.dy) > 2) {
      didDrag = true;
      if (Math.abs(movement.dx) > 4) {
        setState(movement.dx > 0 ? "runningRight" : "runningLeft");
      } else {
        setState("running");
      }
    }
  }, 16);
}

function endDrag(event) {
  if (!dragStart) return;
  window.clearInterval(dragInterval);
  window.desktopPet.dragEnd();
  canvas.classList.remove("dragging");

  const heldDuration = performance.now() - dragStart.time;
  const { kind, expression } = dragStart;
  dragStart = null;

  if (didDrag) {
    didDrag = false;
    if (settings.expressionMode === "clickOnly") {
      setStaticExpression(expression?.state || "idle", expression?.frame || 0);
    } else {
      setState(conversationActive ? conversationAction : "idle");
      scheduleIdleBehavior();
      respondToInteraction("drop");
    }
    return;
  }

  if (heldDuration > 450) {
    if (settings.expressionMode !== "clickOnly") handleLongPress();
    return;
  }
  if (settings.expressionMode === "clickOnly") {
    const sequenceCount = registerClickSequence();
    if (event.detail > 1) {
      if (event.detail === 2) pendingDoubleClickSequenceCount = sequenceCount;
      else if (event.detail > 2) handleClickOnlyPointerClick(sequenceCount);
      return;
    }
    handleClickOnlyPointerClick(sequenceCount);
    return;
  }
  const sequenceCount = registerClickSequence();
  if (event.detail > 1) {
    // The second click is handled by dblclick. Later clicks in the same burst
    // do not produce another dblclick event, so feed those into the normal path.
    if (event.detail === 2) pendingDoubleClickSequenceCount = sequenceCount;
    else if (event.detail > 2) handleClick(kind, true, sequenceCount);
    return;
  }
  scheduleSingleClick(kind, sequenceCount);
}

let bubbleDeadline = 0;
let bubbleRemaining = 0;
let bubblePaused = false;
let bubbleStreaming = false;
let clickReactionBubbleReadyAt = 0;

function dismissBubble() {
  window.clearTimeout(bubbleTimer);
  clickReactionBubbleReadyAt = 0;
  clickReactionBubbleVisible = false;
  speechBubble.classList.remove("visible");
  bubbleVisible = false;
  conversationActive = false;
  conversationAction = "idle";
  temporaryToken += 1;
  temporaryAnimationActive = false;
  if (settings.expressionMode === "automatic" && !dragStart) {
    setState(musicModeEnabled && character.states.listening_music ? "listening_music" : "idle");
  }
  scheduleIdleBehavior();
  const pending = queuedNotice;
  queuedNotice = null;
  if (pending && pending.expiresAt > Date.now()) handlePetMessage(pending.message);
}

function clearPresentation() {
  queuedNotice = null;
  bubbleStreaming = false;
  bubblePaused = false;
  stopSpeech();
  dismissBubble();
}

function hideBubbleLater(duration) {
  window.clearTimeout(bubbleTimer);
  bubbleRemaining = duration;
  bubbleDeadline = Date.now() + duration;
  if (!bubblePaused && !bubbleStreaming && !speechActive) bubbleTimer = window.setTimeout(dismissBubble, duration);
}

function showBubble(text, duration = Math.min(22000, Math.max(4500, String(text || "").length * 110))) {
  if (!speechBubble || !text) return;
  window.clearTimeout(bubbleTimer);
  const continuing = speechBubble.textContent && String(text).startsWith(speechBubble.textContent);
  const follow = continuing && speechBubble.scrollHeight - speechBubble.scrollTop - speechBubble.clientHeight < 24;
  speechBubble.textContent = text;
  if (follow) speechBubble.scrollTop = speechBubble.scrollHeight;
  else if (!continuing) speechBubble.scrollTop = 0;
  speechBubble.classList.add("visible");
  bubbleVisible = true;
  speechBubble.title = window.DesktopPetI18n.t("pet.openChat", {}, activeLanguage);
  hideBubbleLater(duration);
}

speechBubble.addEventListener("mouseenter", () => {
  bubblePaused = true;
  bubbleRemaining = Math.max(1500, bubbleDeadline - Date.now());
  window.clearTimeout(bubbleTimer);
});
speechBubble.addEventListener("mouseleave", () => { bubblePaused = false; hideBubbleLater(bubbleRemaining); });
speechBubble.addEventListener("focus", () => { bubblePaused = true; window.clearTimeout(bubbleTimer); });
speechBubble.addEventListener("blur", () => { bubblePaused = false; hideBubbleLater(Math.max(3000, bubbleRemaining)); });
speechBubble.addEventListener("click", () => window.desktopPet.openChatWindow());
talkButton.addEventListener("click", () => { voiceLineLastInteraction = Date.now(); if (voiceLineAudio) stopVoiceLine(); scheduleIdleVoiceLine(); window.desktopPet.openQuickChatWindow(); });

function finishSpeech(token, failed = false, reason = "") {
  if (token !== speechToken) return;
  stopSpeech(failed ? "error" : "idle", reason);
  if (bubbleVisible) hideBubbleLater(Math.max(3000, bubbleRemaining));
}

function chooseTtsVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (settings.tts.voiceName) {
    const exact = voices.find((voice) => voice.name === settings.tts.voiceName);
    if (exact) return exact;
  }
  const languagePrefix = activeLanguage.split("-")[0];
  return voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith(languagePrefix))
    || voices.find((voice) => /^zh/i.test(voice.lang))
    || voices.find((voice) => /^ja|^en/i.test(voice.lang))
    || voices[0];
}

function stopSpeech(status = "idle", reason = "") {
  speechToken += 1;
  speechActive = false;
  const wasFishPlaying = fishAudioPlaying;
  fishAudioPlaying = false;
  if (wasFishPlaying && isAnimationMode()) startAnimation();
  if (speechId !== null) window.desktopPet.speechStateChanged({ id: speechId, status, ...(reason ? { reason } : {}) });
  speechId = null;
  window.clearTimeout(speechWatchdog);
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio.src = "";
    activeAudio = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  scheduleIdleVoiceLine();
}

async function speakText(text) {
  stopVoiceLine();
  stopSpeech();
  const token = speechToken;
  if (!settings.tts?.enabled || settings.tts.provider === "none" || !String(text || "").trim()) return;
  speechActive = true;
  window.clearTimeout(bubbleTimer);
  try {
    const id = await window.desktopPet.beginSpeech(speechGeneration);
    if (token !== speechToken) {
      if (id !== null) window.desktopPet.speechStateChanged({ id, status: "idle" });
      return;
    }
    if (id === null) { finishSpeech(token); return; }
    speechId = id;
    const external = settings.tts.provider !== "system";
    const chunks = window.DesktopPetSpeechText.splitSpeechText(text, external ? (settings.tts.provider === "fish" ? 3000 : 800) : 400);
    let index = 0;
    const playNext = async () => {
      if (token !== speechToken) return;
      if (index === chunks.length) { finishSpeech(token); return; }
      const chunk = chunks[index++];
      window.clearTimeout(speechWatchdog);
      speechWatchdog = window.setTimeout(() => finishSpeech(token, true, "tts_timeout"), 300000);
      window.desktopPet.speechStateChanged({ id, status: "preparing" });
      try {
        if (external) {
          const result = await window.desktopPet.synthesizeSpeech({ id, text: chunk });
          if (token !== speechToken) return;
          if (!result?.ok || !result.audioDataUrl) {
            const error = String(result?.error || "");
            const reason = result?.cancelled ? "" : /configuration_required|missing_tts_endpoint/.test(error)
              ? "voice_not_configured" : /timeout/.test(error) ? "tts_timeout" : "tts_request_failed";
            finishSpeech(token, !result?.cancelled, reason);
            return;
          }
          try {
            activeAudio = new Audio(result.audioDataUrl);
            activeAudio.volume = settings.tts.volume;
          } catch {
            finishSpeech(token, true, "audio_creation_failed");
            return;
          }
          activeAudio.onended = () => {
            if (token === speechToken && settings.tts.provider === "fish") { fishAudioPlaying = false; if (isAnimationMode()) startAnimation(); }
            playNext();
          };
          activeAudio.onerror = () => finishSpeech(token, true, "audio_playback_failed");
          try { await activeAudio.play(); }
          catch { finishSpeech(token, true, "audio_playback_failed"); return; }
          if (token === speechToken && settings.tts.provider === "fish") { fishAudioPlaying = true; if (isAnimationMode()) startAnimation(); }
          if (token === speechToken) window.desktopPet.speechStateChanged({ id, status: "playing" });
        } else {
          if (!("speechSynthesis" in window)) { finishSpeech(token, true); return; }
          const utterance = new SpeechSynthesisUtterance(chunk);
          const voice = chooseTtsVoice();
          if (voice) utterance.voice = voice;
          utterance.rate = Math.min(Math.max(Number(settings.tts.rate) || 1, 0.5), 1.8);
          utterance.pitch = Math.min(Math.max(Number(settings.tts.pitch) || 1, 0.5), 1.8);
          utterance.volume = settings.tts.volume;
          utterance.onstart = () => {
            if (token === speechToken) window.desktopPet.speechStateChanged({ id, status: "playing" });
          };
          utterance.onend = playNext;
          utterance.onerror = () => finishSpeech(token, true, "audio_playback_failed");
          window.speechSynthesis.speak(utterance);
        }
      } catch { finishSpeech(token, true, external ? "tts_request_failed" : "audio_playback_failed"); }
    };
    await playNext();
  } catch {
    finishSpeech(token, true, "audio_playback_failed");
  }
}

function stopVoiceLine() {
  voiceLineRequestToken += 1;
  window.desktopPet.reportVoiceLinePlayback?.(false);
  if (voiceLineAudio) {
    voiceLineAudio.pause();
    voiceLineAudio.src = "";
    voiceLineAudio = null;
  }
}

async function playVoiceLine(category = "all", prioritize = false, test = false) {
  if (!settings.voiceLines?.enabled) return false;
  if (!prioritize && (chatRequestActive || conversationActive || bubbleVisible || speechActive || dragStart || state !== "idle" || voiceLineAudio || Date.now() - voiceLineLastInteraction < 30000)) return false;
  const token = ++voiceLineRequestToken;
  window.desktopPet.reportVoiceLinePlayback?.(true);
  if (voiceLineAudio) { voiceLineAudio.pause(); voiceLineAudio.src = ""; voiceLineAudio = null; }
  const request = window.desktopPet.getRandomVoiceLine(category, test);
  if (prioritize) stopSpeech();
  let result;
  try { result = await request; } catch {
    if (token === voiceLineRequestToken) window.desktopPet.reportVoiceLinePlayback?.(false);
    return false;
  }
  if (token !== voiceLineRequestToken || !result?.ok) {
    if (token === voiceLineRequestToken) window.desktopPet.reportVoiceLinePlayback?.(false);
    if (!prioritize) scheduleIdleVoiceLine(result?.error === "clips_unavailable" ? null : 5000);
    return false;
  }
  const audio = new Audio(`data:audio/mpeg;base64,${result.data}`);
  audio.volume = settings.voiceLines?.volume ?? 0.7;
  voiceLineAudio = audio;
  window.desktopPet.reportVoiceLinePlayback?.(true);
  const finishVoiceLine = (retryDelay = null) => {
    if (voiceLineAudio !== audio) return;
    audio.src = "";
    voiceLineAudio = null;
    window.desktopPet.reportVoiceLinePlayback?.(false);
    if (retryDelay === null) scheduleIdleVoiceLine();
    else scheduleIdleVoiceLine(retryDelay);
  };
  audio.onended = () => finishVoiceLine();
  audio.onerror = () => finishVoiceLine(5000);
  try { await audio.play(); return true; } catch { finishVoiceLine(5000); return false; }
}

function scheduleIdleVoiceLine(delayOverride = null) {
  window.clearTimeout(voiceLineIdleTimer);
  voiceLineIdleTimer = null;
  if (!settings.voiceLines?.enabled || !settings.voiceLines?.idleVoiceEnabled) return;
  const min = Math.min(settings.voiceLines.idleIntervalMinSeconds, settings.voiceLines.idleIntervalMaxSeconds);
  const max = Math.max(settings.voiceLines.idleIntervalMinSeconds, settings.voiceLines.idleIntervalMaxSeconds);
  const interval = delayOverride ?? (min + Math.random() * (max - min)) * 1000;
  voiceLineIdleTimer = window.setTimeout(async () => {
    voiceLineIdleTimer = null;
    const recentlyActive = Date.now() - voiceLineLastInteraction < 30000;
    let chatFocused = false;
    try { chatFocused = await window.desktopPet.isChatActive(); } catch { /* Chat focus is an optional activity signal. */ }
    if (recentlyActive || chatFocused || chatRequestActive || conversationActive || bubbleVisible || speechActive || dragStart || state !== "idle" || voiceLineAudio) {
      scheduleIdleVoiceLine(5000);
      return;
    }
    const categories = [...settings.voiceLines.idleCategories];
    if (settings.voiceLines.nightEnabled && isNightCategoryActive(new Date(), settings.voiceLines.nightStart, settings.voiceLines.nightEnd)) categories.push(settings.voiceLines.nightCategory);
    playVoiceLine(allowedVoiceCategories(categories), false);
  }, interval);
}

function allowedVoiceCategories(categories = []) {
  const selected = Array.isArray(categories) ? categories : [categories];
  const nightAllowed = settings.voiceLines?.nightEnabled
    && isNightCategoryActive(new Date(), settings.voiceLines.nightStart, settings.voiceLines.nightEnd);
  return selected.filter((category) => category !== settings.voiceLines?.nightCategory || nightAllowed);
}

function isNightCategoryActive(date, start, end) {
  const minute = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = minute(start); const to = minute(end);
  if (from === null || to === null || from === to) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

window.desktopPet.onSpeechStopped((generation) => {
  speechGeneration = Math.max(speechGeneration, generation);
  stopSpeech();
  if (bubbleVisible) hideBubbleLater(Math.max(3000, bubbleRemaining));
});
window.desktopPet.onExpressionRequested?.(applyExpressionRequest);
window.desktopPet.onAnimationCegil?.((enabled) => {
  if (!isAnimationMode()) return;
  manualCegilUntil = enabled ? performance.now() + 10000 : 0;
  startAnimation();
});

function handlePetMessage(message = {}) {
  if (message.clear) {
    clearPresentation();
    return;
  }
  const isChat = message.source === "chat";
  if (!isChat && (conversationActive || speechActive)) {
    // Keep only the latest recent reminder; never replay a backlog after a chat.
    queuedNotice = { message, expiresAt: Date.now() + 60000 };
    return;
  }
  const wasStreaming = bubbleStreaming;
  bubbleStreaming = message.streaming === true;
  const text = typeof message === "string" ? message : message.text;
  const bubbleText = typeof message === "object" && message.bubbleText ? message.bubbleText : text;
  const action = typeof message === "object" ? message.action : "";
  clickReactionBubbleVisible = false;
  if (isChat) {
    voiceLineLastInteraction = Date.now();
    stopVoiceLine();
    scheduleIdleVoiceLine();
    if (!conversationActive || (!wasStreaming && bubbleStreaming)) conversationAction = "idle";
    conversationActive = true;
    if (action && character.states[action]) conversationAction = action;
    window.clearTimeout(idleTimer);
    temporaryToken += 1;
    temporaryAnimationActive = false;
  }
  stopSpeech();
  showBubble(bubbleText, message.duration);
  if (typeof message !== "object" || message.speak !== false) {
    speakText(text);
  }
  if ((settings.expressionMode === "automatic" || speechActive) && !dragStart) {
    if (isChat) setState(conversationAction);
    else if (action && character.states[action]) playTemporary(action, Math.max(temporaryDuration(action), 1200));
  }
  if (message.notification) window.desktopPet.presentNotification?.(message.notification);
}

function startupGreetingText() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return text("pet.greeting.morning");
  if (hour >= 11 && hour < 14) return text("pet.greeting.noon");
  if (hour >= 14 && hour < 18) return text("pet.greeting.afternoon");
  if (hour >= 18 && hour < 23) return text("pet.greeting.evening");
  return text("pet.greeting.night");
}

function scheduleStartupGreeting() {
  if (didShowStartupGreeting) return;
  didShowStartupGreeting = true;
  window.setTimeout(() => {
    handlePetMessage({ text: startupGreetingText(), action: "waving", duration: 2800, speak: false });
  }, 650);
}

function loadSprite(spritePath) {
  return new Promise((resolve, reject) => {
    const nextImage = new Image();
    nextImage.addEventListener("load", () => {
      resolve(nextImage);
    }, { once: true });
    nextImage.addEventListener("error", reject, { once: true });
    nextImage.src = spritePath;
  });
}

function requestStreamedFrame(framePath) {
  if (!framePath || streamedFrameCache.has(framePath)) return;
  if (!isCegilAnimationMode() && !isAnimationMode()) return;
  while (streamedFrameCache.size >= STREAMED_FRAME_CACHE_LIMIT) {
    const oldestPath = streamedFrameCache.keys().next().value;
    const oldest = streamedFrameCache.get(oldestPath);
    streamedFrameCache.delete(oldestPath);
    if (oldest?.image) oldest.image.removeAttribute("src");
  }
  const image = new Image();
  const generation = streamedFrameGeneration;
  const entry = { image, loaded: false, generation };
  streamedFrameCache.set(framePath, entry);
  image.addEventListener("load", () => {
    if (generation !== streamedFrameGeneration || (!isCegilAnimationMode() && !isAnimationMode()) || streamedFrameCache.get(framePath) !== entry) return;
    entry.loaded = true;
    if ((isAnimationMode() && activeAnimationAsset()?.framePaths?.[frameIndex] === framePath)
      || (isCegilAnimationMode() && state === "idle" && character.cegilIdle?.framePaths?.[frameIndex] === framePath)) draw();
  }, { once: true });
  image.addEventListener("error", (error) => {
    if (generation === streamedFrameGeneration && (isCegilAnimationMode() || isAnimationMode()) && streamedFrameCache.get(framePath) === entry) {
      streamedFrameCache.delete(framePath);
      failedStreamedFrames.add(framePath);
      console.error("Unable to load Rem idle frame", framePath, error);
    }
  }, { once: true });
  image.src = framePath;
}

function preloadStreamedFrames(descriptor, currentFrame) {
  if (!descriptor?.framePaths?.length) return;
  for (let offset = 1; offset <= 2; offset += 1) {
    requestStreamedFrame(descriptor.framePaths[(currentFrame + offset) % descriptor.frames]);
  }
}

canvas.addEventListener("pointerdown", beginDrag);
canvas.addEventListener("dblclick", handleDoubleClick);
canvas.addEventListener("pointerenter", () => {
  if (settings.expressionMode !== "automatic" || conversationActive || dragStart || performance.now() < hoverReadyAt) return;
  hoverReadyAt = performance.now() + 10000;
  if (state === "idle") playTemporary("waving", 900);
});
window.addEventListener("pointerup", endDrag);
function cancelDrag() {
  if (!dragStart) return;
  const expression = dragStart.expression;
  dragStart = null;
  didDrag = false;
  window.clearInterval(dragInterval);
  window.desktopPet.dragEnd();
  canvas.classList.remove("dragging");
  if (settings.expressionMode === "automatic") setState(conversationActive ? conversationAction : "idle");
  else if (expression) setStaticExpression(expression.state, expression.frame);
}
window.addEventListener("blur", cancelDrag);
window.addEventListener("pointercancel", cancelDrag);

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.desktopPet.showContextMenu();
});
window.addEventListener("keydown", () => { voiceLineLastInteraction = Date.now(); }, true);
window.addEventListener("beforeunload", () => {
  window.clearTimeout(voiceLineIdleTimer);
  voiceLineIdleTimer = null;
  stopVoiceLine();
  if (animationRaf) cancelAnimationFrame(animationRaf);
  animationGeneration += 1;
  clearStreamedFrameCache();
});

document.addEventListener?.("visibilitychange", () => {
  if (document.hidden) {
    window.clearInterval(animationTimer);
    if (animationRaf) cancelAnimationFrame(animationRaf);
    animationRaf = 0;
    animationGeneration += 1;
  } else {
    startAnimation();
  }
});

window.desktopPet.onAppStateUpdated(applyAppState);
window.desktopPet.onPetMessage(handlePetMessage);
window.desktopPet.onChatStateUpdated?.((chatState) => {
  chatRequestActive = chatState.busy === true;
  if (chatRequestActive) {
    voiceLineLastInteraction = Date.now();
    stopVoiceLine();
  }
  scheduleIdleVoiceLine();
});

window.desktopPet.getAppState()
  .then((initialAppState) => {
    applyAppState(initialAppState);
  })
  .catch((error) => {
    console.error("Unable to start Desktop Pet", error);
  });
