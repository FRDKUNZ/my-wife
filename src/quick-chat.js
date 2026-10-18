const form = document.querySelector("#quick-form");
const input = document.querySelector("#quick-input");
const sendButton = document.querySelector("#send");
const closeButton = document.querySelector("#close");
const statusEl = document.querySelector("#status");
const stopButton = document.querySelector("#stop");
const characterNameEl = document.querySelector("#character-name");
const historyButton = document.querySelector("#history");
const settingsButton = document.querySelector("#settings");
const retryButton = document.querySelector("#retry-message");
const i18n = window.DesktopPetI18n;
const draft = window.DesktopPetDraft.create(input);

let sending = false;
let remoteBusy = false;
let chatRevision = 0;
let sendToken = 0;
let activeLanguage = "zh-CN";
let characterName = "Desktop Pet";
let replyStarted = false;
let history = [];
let voiceError = false;
let receivedState = false;

function text(key, variables = {}) {
  return i18n.t(key, variables, activeLanguage);
}

function applyTranslations() {
  document.documentElement.lang = activeLanguage;
  document.title = text("window.quickChatTitle");
  characterNameEl.textContent = characterName;
  characterNameEl.title = characterName;
  input.placeholder = text("quick.toCharacter", { name: characterName });
  historyButton.textContent = text("quick.history");
  settingsButton.textContent = text("chat.openSettings");
  sendButton.textContent = text("quick.send");
  closeButton.setAttribute("aria-label", text("quick.close"));
  stopButton.textContent = text("chat.stop");
  retryButton.textContent = text("chat.retry");
  retryButton.hidden = !history.at(-1)?.failed || sending || remoteBusy;
  input.setAttribute("aria-label", text("quick.placeholder"));
  setStatus(sending || remoteBusy ? text(replyStarted ? "quick.responding" : "quick.waiting")
    : history.at(-1)?.failed ? text("quick.replyFailed") : voiceError ? text("tts.playbackFailed") : text("quick.idle"));
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function sendQuickMessage(retryText) {
  if (sending || remoteBusy) return;
  const messageText = (retryText ?? input.value).trim();
  if (!messageText) return;
  sending = true;
  const token = ++sendToken;
  const context = draft.context();
  sendButton.disabled = true;
  sendButton.hidden = true;
  stopButton.hidden = false;
  retryButton.hidden = true;
  draft.clearIfMatches(messageText);
  input.focus();
  setStatus(text("quick.waiting"));
  try {
    const result = await window.desktopPet.sendChatMessage(messageText, context);
    if (token !== sendToken || result.cancelled || result.revision < chatRevision) return;
    remoteBusy = result.busy === true;
    history = Array.isArray(result.history) ? result.history : history;
    if (!result.ok) draft.restore(messageText, context);
    setStatus(remoteBusy ? text("quick.waiting") : result.ok ? text("quick.replied") : text("quick.replyFailed"));
  } catch {
    if (token !== sendToken) return;
    draft.restore(messageText, context);
    setStatus(text("quick.sendFailed"));
  } finally {
    if (token === sendToken) {
      sending = false;
      sendButton.disabled = remoteBusy;
      sendButton.hidden = remoteBusy;
      stopButton.hidden = !remoteBusy;
      retryButton.hidden = !history.at(-1)?.failed || remoteBusy;
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendQuickMessage();
});

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
  event.preventDefault();
  sendQuickMessage();
});
historyButton.addEventListener("click", () => { window.desktopPet.openChatWindow(); window.close(); });
settingsButton.addEventListener("click", () => window.desktopPet.openCompanionSettings());

closeButton.addEventListener("click", () => window.close());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) window.close();
});

input.focus();

async function initialize() {
  const state = await window.desktopPet.getChatState();
  if (!receivedState) applyChatState(state);
}

function applyChatState(state = {}) {
  if (Number.isFinite(state.revision) && state.revision < chatRevision) return;
  if (Number.isFinite(state.revision) && state.revision > chatRevision) {
    chatRevision = state.revision;
    sendToken += 1;
    sending = false;
  }
  draft.applyState(state);
  remoteBusy = state.busy === true;
  history = Array.isArray(state.history) ? state.history : history;
  voiceError = state.voiceError === true;
  characterName = state.config?.persona?.name || state.character?.name || characterName;
  replyStarted = Boolean(state.pending?.reply);
  sendButton.disabled = sending || remoteBusy;
  sendButton.hidden = sending || remoteBusy;
  stopButton.hidden = !(sending || remoteBusy);
  activeLanguage = state.resolvedLanguage || state.config?.resolvedLanguage || activeLanguage;
  applyTranslations();
}

stopButton.addEventListener("click", async () => {
  try { applyChatState(await window.desktopPet.stopChat()); setStatus(text("chat.stopped")); }
  catch { setStatus(text("quick.sendFailed")); }
});

retryButton.addEventListener("click", () => {
  const message = [...history].reverse().find((item) => item.role === "user");
  if (message && history.at(-1)?.failed) sendQuickMessage(message.content);
});

window.desktopPet.onChatStateUpdated((state) => { receivedState = true; applyChatState(state); });

initialize().catch(applyTranslations);
