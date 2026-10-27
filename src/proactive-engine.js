const { randomUUID } = require("node:crypto");

const DEFAULT_POLICY = Object.freeze({
  enabled: true, confidenceThreshold: 0.72, curiosityTtlDays: 30,
  maxFollowupAttempts: 2, globalCooldownMs: 30 * 60_000,
  categoryCooldownMs: { follow_up: 6 * 60 * 60_000, curiosity: 12 * 60 * 60_000 },
  minSamplesForAdaptation: 5, maxActionsPerSession: 1,
});

function blankState() {
  return { intentions: [], curiosities: [], feedback: [], actions: [], suppressTopics: [] };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    intentions: Array.isArray(state.intentions) ? state.intentions.slice(-100) : [],
    curiosities: Array.isArray(state.curiosities) ? state.curiosities.slice(-100) : [],
    feedback: Array.isArray(state.feedback) ? state.feedback.slice(-500) : [],
    actions: Array.isArray(state.actions) ? state.actions.slice(-100) : [],
    suppressTopics: Array.isArray(state.suppressTopics) ? state.suppressTopics.slice(-100) : [],
  };
}

function analyzeUserMessage(rawText, stateValue, { now = Date.now(), sourceRef = null, policy = DEFAULT_POLICY } = {}) {
  const state = normalizeState(stateValue);
  const text = String(rawText || "").trim();
  if (!text) return { state, created: [] };
  const topic = text.replace(/^(?:besok|nanti|minggu depan|aku|saya|kayaknya|mungkin)\s+/i, "").replace(/[.!?]+$/g, "").slice(0, 180);
  const completion = /\b(sudah|udah|berhasil|selesai|kelar|fixed|beres)\b/i.test(text);
  const cancellation = /\b(batal|dibatalkan|gak jadi|nggak jadi|tidak jadi|cancel)\b/i.test(text);
  const created = [];
  for (const item of state.intentions) {
    if (item.status !== "pending" && item.status !== "due") continue;
    if (!isRelevant(text, item.topic)) continue;
    if (completion) { item.status = "completed"; item.updatedAt = now; item.resolution = "user_reported_complete"; }
    else if (cancellation) { item.status = "cancelled"; item.updatedAt = now; item.resolution = "user_cancelled"; }
  }
  for (const item of state.curiosities) {
    if (item.status !== "asked" || !isRelevant(text, item.topic)) continue;
    if (cancellation || /\b(jangan|berhenti|gak usah|nggak usah|tidak usah|enggan|malas bahas)\b/i.test(text)) {
      item.status = "dismissed";
      state.suppressTopics.push({ topic: item.topic, createdAt: now });
      state.feedback.push({ category: "curiosity", outcome: "dismissed", at: now, trigger: { topic: item.topic } });
    } else if (/\b(nanti|lain kali|besok saja|tunda)\b/i.test(text)) {
      item.status = "pending"; item.lastAskedAt = now;
      state.feedback.push({ category: "curiosity", outcome: "deferred", at: now, trigger: { topic: item.topic } });
    } else if (text.length > 12) {
      item.status = "answered";
      state.feedback.push({ category: "curiosity", outcome: "engaged", at: now, trigger: { topic: item.topic } });
    }
  }
  if (cancellation) state.suppressTopics.push({ topic, createdAt: now });

  const explicit = /\b(aku|saya|nanti|besok|minggu depan|akan|bakal|janji|rencana|lanjut)\b/i.test(text)
    && /\b(akan|bakal|mau|ingin|pengen|lanjut|coba|kerjakan|perbaiki|selesaikan|janji|tanya|bahas)\b/i.test(text);
  if (explicit && !completion && !cancellation && topic.length >= 6) {
    const dueAt = /\bbesok\b/i.test(text) ? localTomorrow(now) : null;
    const existing = state.intentions.find((item) => ["pending", "due"].includes(item.status) && isRelevant(topic, item.topic));
    if (existing) {
      existing.content = topic; existing.topic = topic; existing.updatedAt = now;
      if (dueAt) existing.dueAt = dueAt;
    } else {
      const item = { id: randomUUID(), content: topic, type: /janji|janji/i.test(text) ? "promise" : /tanya|bahas/i.test(text) ? "open_question" : "plan",
        sourceRef, createdAt: now, updatedAt: now, dueAt, status: dueAt && dueAt <= now ? "due" : "pending",
        confidence: /besok|janji|akan|bakal|lanjut/i.test(text) ? 0.88 : 0.73, context: text.slice(0, 300), topic,
        lastFollowedUpAt: null, attempts: 0 };
      state.intentions.push(item); created.push({ kind: "intention", item });
    }
  }

  const meaningful = text.length >= 35 && !/^(halo|hai|hi|ok|oke|iya|ya|makasih|terima kasih)\b/i.test(text);
  const key = topic.toLocaleLowerCase();
  const suppressed = state.suppressTopics.some((item) => isRelevant(key, item.topic));
  const duplicate = state.curiosities.some((item) => !["answered", "dismissed", "expired"].includes(item.status) && isRelevant(key, item.topic));
  if (meaningful && !suppressed && !duplicate && state.curiosities.filter((item) => item.createdAt >= now - 86_400_000).length < 1) {
    const item = { id: randomUUID(), topic, question: `Akhirnya kamu memilih pendekatan yang mana untuk ${topic}?`, sourceRef,
      createdAt: now, expiresAt: now + policy.curiosityTtlDays * 86_400_000, status: "pending", confidence: 0.74,
      lastAskedAt: null, attempts: 0 };
    state.curiosities.push(item); created.push({ kind: "curiosity", item });
  }
  return { state, created };
}

function localTomorrow(now) {
  const next = new Date(now); next.setDate(next.getDate() + 1); next.setHours(9, 0, 0, 0); return next.getTime();
}
function isRelevant(text, topic) {
  const a = String(text || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const b = String(topic || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!a || !b) return false;
  const terms = b.split(/\s+/).filter((word) => word.length > 3);
  const overlap = terms.filter((word) => a.includes(word)).length;
  return terms.length > 0 && overlap >= Math.min(1, Math.ceil(terms.length / 2));
}

function eligibleCandidate(stateValue, context, { now = Date.now(), policy = DEFAULT_POLICY } = {}) {
  const state = normalizeState(stateValue);
  if (!policy.enabled || !context?.available || context.busy || context.audioPlaying || context.muted || context.dnd) return { type: "quiet_presence", reason: "unavailable_or_busy" };
  const last = state.actions.at(-1);
  if (last && now - last.at < policy.globalCooldownMs) return { type: "quiet_presence", reason: "global_cooldown" };
  const relevance = (item) => context.topic && isRelevant(context.topic, item.topic);
  const due = state.intentions.filter((item) => ["pending", "due"].includes(item.status) && item.dueAt && item.dueAt <= now
    && item.confidence >= policy.confidenceThreshold && item.attempts < policy.maxFollowupAttempts && relevance(item))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (due) return { type: "follow_up", item: due, reason: "due_and_relevant" };
  const curiosity = state.curiosities.filter((item) => item.status === "pending" && item.expiresAt > now
    && item.confidence >= policy.confidenceThreshold && relevance(item)
    && adaptation(state, "curiosity", policy).multiplier >= 0.4)[0];
  if (curiosity) return { type: "curiosity", item: curiosity, reason: "specific_topic_relevant" };
  return { type: "quiet_presence", reason: "no_relevant_candidate" };
}

function recordAction(stateValue, candidate, now = Date.now()) {
  const state = normalizeState(stateValue);
  if (candidate?.item) {
    candidate.item.attempts = (candidate.item.attempts || 0) + 1;
    candidate.item.lastFollowedUpAt = now;
    if (candidate.type === "curiosity") { candidate.item.lastAskedAt = now; candidate.item.status = "asked"; }
    else candidate.item.status = "due";
  }
  state.actions.push({ category: candidate?.type || "spontaneous", at: now, reason: candidate?.reason || "unspecified", sourceRef: candidate?.item?.id || null });
  return state;
}

function recordFeedback(stateValue, category, outcome, trigger = null, now = Date.now()) {
  const state = normalizeState(stateValue);
  if (!["engaged", "ignored", "deferred", "dismissed", "silenced"].includes(outcome)) return state;
  state.feedback.push({ category, outcome, at: now, trigger });
  if (["dismissed", "silenced"].includes(outcome) && trigger?.topic) state.suppressTopics.push({ topic: trigger.topic, createdAt: now });
  return state;
}

function adaptation(stateValue, category, policy = DEFAULT_POLICY) {
  const rows = normalizeState(stateValue).feedback.filter((item) => item.category === category);
  if (rows.length < policy.minSamplesForAdaptation) return { sampleCount: rows.length, multiplier: 1 };
  const counts = Object.fromEntries(["engaged", "ignored", "deferred", "dismissed", "silenced"].map((outcome) => [outcome, rows.filter((item) => item.outcome === outcome).length]));
  const multiplier = Math.max(0.25, Math.min(1.2, (counts.engaged + 5) / (counts.engaged + counts.ignored + counts.dismissed + counts.silenced + 10)));
  return { sampleCount: rows.length, multiplier, counts };
}

function expireItems(stateValue, now = Date.now(), policy = DEFAULT_POLICY) {
  const state = normalizeState(stateValue);
  for (const item of state.intentions) {
    if (["pending", "due"].includes(item.status) && item.dueAt && item.dueAt <= now) item.status = "due";
    if (["pending", "due"].includes(item.status) && item.attempts >= policy.maxFollowupAttempts) item.status = "expired";
  }
  for (const item of state.curiosities) if (["pending", "asked"].includes(item.status) && item.expiresAt <= now) item.status = "expired";
  return state;
}

module.exports = { DEFAULT_POLICY, blankState, normalizeState, analyzeUserMessage, eligibleCandidate, recordAction, recordFeedback, adaptation, expireItems, isRelevant };
