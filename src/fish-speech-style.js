function fishSpeechStyle(rawText) {
  const text = String(rawText || "").replace(/\s+/gu, " ").trim();

  return {
    // Avoid square-bracket emotion tags: the current reference voice/model may
    // pronounce them literally. Natural wording and punctuation carry the tone.
    text,
    temperature: 0.78,
    top_p: 0.78,
    prosody: { speed: 0.96, volume: 0, normalize_loudness: true },
    chunk_length: 220,
    condition_on_previous_chunks: true,
    latency: "normal",
    format: "mp3",
  };
}

module.exports = { fishSpeechStyle };
