const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  getAppState: () => ipcRenderer.invoke("get-app-state"),
  getRandomVoiceLine: (category, test = false) => ipcRenderer.invoke("get-random-voice-line", category, test),
  listVoiceLines: () => ipcRenderer.invoke("list-voice-lines"),
  chooseVoiceFolder: () => ipcRenderer.invoke("choose-voice-folder"),
  chooseSplitterSource: () => ipcRenderer.invoke("choose-splitter-source"),
  chooseSplitterFile: (kind) => ipcRenderer.invoke("choose-splitter-file", kind),
  analyzeVoiceFile: (request) => ipcRenderer.invoke("analyze-voice-file", request),
  cancelVoiceProcessing: () => ipcRenderer.invoke("cancel-voice-processing"),
  previewVoiceSegment: (request) => ipcRenderer.invoke("preview-voice-segment", request),
  exportVoiceSegments: (request) => ipcRenderer.invoke("export-voice-segments", request),
  openVoiceOutput: (folder) => ipcRenderer.invoke("open-voice-output", folder),
  checkFfmpeg: () => ipcRenderer.invoke("check-ffmpeg"),
  onSplitterProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("splitter-progress", listener);
    return () => ipcRenderer.off("splitter-progress", listener);
  },
  setSettings: (patch) => ipcRenderer.send("set-settings", patch),
  getChatState: () => ipcRenderer.invoke("get-chat-state"),
  isChatActive: () => ipcRenderer.invoke("is-chat-active"),
  pauseAutonomousConversation: (minutes) => ipcRenderer.invoke("pause-autonomous-conversation", minutes),
  testAutonomousConversation: () => ipcRenderer.invoke("test-autonomous-conversation"),
  reportVoiceLinePlayback: (playing) => ipcRenderer.send("voice-line-playback", playing),
  saveChatConfig: (patch) => ipcRenderer.invoke("save-chat-config", patch),
  testAssistantConnection: (patch) => ipcRenderer.invoke("test-assistant-connection", patch),
  listAssistantModels: (patch) => ipcRenderer.invoke("list-assistant-models", patch),
  testTtsConnection: (patch) => ipcRenderer.invoke("test-tts-connection", patch),
  sendChatMessage: (text, context) => ipcRenderer.invoke("send-chat-message", text, context),
  reactToClick: (kind, clickCount) => ipcRenderer.invoke("react-to-click", kind, {
    milestone: Number.isInteger(clickCount) && clickCount >= 5 && clickCount % 5 === 0,
    clickCount,
  }),
  setChatDraft: (draft) => ipcRenderer.send("set-chat-draft", draft),
  onChatDraftUpdated: (callback) => {
    const listener = (_event, draft) => callback(draft);
    ipcRenderer.on("chat-draft-updated", listener);
    return () => ipcRenderer.off("chat-draft-updated", listener);
  },
  clearChatHistory: () => ipcRenderer.invoke("clear-chat-history"),
  stopChat: () => ipcRenderer.invoke("stop-chat"),
  confirmDiscard: () => ipcRenderer.invoke("confirm-discard"),
  previewCharacterImport: (kind) => ipcRenderer.invoke("preview-character-import", kind),
  confirmCharacterImport: (token) => ipcRenderer.invoke("confirm-character-import", token),
  removeCharacterImport: (id) => ipcRenderer.invoke("remove-character-import", id),
  beginSpeech: (generation) => ipcRenderer.invoke("begin-speech", generation),
  speechStateChanged: (change) => ipcRenderer.send("speech-state-changed", change),
  stopVoice: () => ipcRenderer.invoke("stop-voice"),
  replaySpeech: () => ipcRenderer.invoke("replay-speech"),
  onSpeechStopped: (callback) => {
    const listener = (_event, generation) => callback(generation);
    ipcRenderer.on("speech-stopped", listener);
    return () => ipcRenderer.off("speech-stopped", listener);
  },
  presentNotification: (notice) => ipcRenderer.send("present-notification", notice),
  synthesizeSpeech: (request) => ipcRenderer.invoke("synthesize-speech", request),
  openChatWindow: () => ipcRenderer.send("open-chat-window"),
  openQuickChatWindow: () => ipcRenderer.send("open-quick-chat-window"),
  openCompanionSettings: () => ipcRenderer.send("open-companion-settings"),
  onChatStateUpdated: (callback) => {
    const listener = (_event, chatState) => callback(chatState);
    ipcRenderer.on("chat-state-updated", listener);
    return () => ipcRenderer.off("chat-state-updated", listener);
  },
  onAppStateUpdated: (callback) => {
    const listener = (_event, appState) => callback(appState);
    ipcRenderer.on("app-state-updated", listener);
    return () => ipcRenderer.off("app-state-updated", listener);
  },
  onExpressionRequested: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("expression-requested", listener);
    return () => ipcRenderer.off("expression-requested", listener);
  },
  onAnimationCegil: (callback) => {
    const listener = (_event, enabled) => callback(enabled === true);
    ipcRenderer.on("animation-cegil", listener);
    return () => ipcRenderer.off("animation-cegil", listener);
  },
  onAnimationCondition: (callback) => {
    const listener = (_event, condition) => callback(condition);
    ipcRenderer.on("animation-condition", listener);
    return () => ipcRenderer.off("animation-condition", listener);
  },
  onPetMessage: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("pet-message", listener);
    return () => ipcRenderer.off("pet-message", listener);
  },
  onBreakupAnimation: (callback) => {
    const listener = (_event, sequence) => callback(sequence);
    ipcRenderer.on("breakup-animation-start", listener);
    return () => ipcRenderer.off("breakup-animation-start", listener);
  },
  beginBreakupAnimationExit: () => ipcRenderer.send("breakup-animation-finishing"),
  finishBreakupAnimation: () => ipcRenderer.send("breakup-animation-finished"),
  onBreakupModeChanged: (callback) => {
    const listener = (_event, active) => callback(active === true);
    ipcRenderer.on("breakup-mode-changed", listener);
    return () => ipcRenderer.off("breakup-mode-changed", listener);
  },
  recordInteraction: (kind) => ipcRenderer.send("record-interaction", kind),
  reportUserActivity: () => ipcRenderer.send("report-user-activity"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragMove: () => ipcRenderer.invoke("drag-move"),
  dragEnd: () => ipcRenderer.send("drag-end"),
});
