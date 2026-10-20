function fishSpeechStyle(rawText) {
  const text = String(rawText || "").replace(/\s+/gu, " ").trim();
  // Keep the configured Fish fields and voice unchanged, with only subtle
  // cadence shifts inferred from punctuation already present in natural text.
  const speed = /[!！]{1,2}/u.test(text) ? 1.01 : /[?？]/u.test(text) ? 0.99 : /[…]{1,}|\.{2,}/u.test(text) ? 0.95 : 0.97;

  return {
    // Avoid square-bracket emotion tags: the current reference voice/model may
    // pronounce them literally. Natural wording and punctuation carry the tone.
    text,
    temperature: 0.78,
    top_p: 0.78,
    prosody: { speed, volume: 0, normalize_loudness: true },
    chunk_length: 220,
    condition_on_previous_chunks: true,
    latency: "normal",
    format: "mp3",
  };
}

module.exports = { fishSpeechStyle };
