function fishSpeechStyle(rawText) {
  const text = String(rawText || "").trim();
  const lower = text.toLocaleLowerCase("id-ID");
  let direction = "[warm]";

  if (/\b(malam|tidur|istirahat|selamat tidur)\b/u.test(lower)) direction = "[near-whisper]";
  else if (/\b(wkwk|haha|hehe|lucu|bercanda|lelucon)\b/u.test(lower)) direction = "[chuckle]";
  else if (/\b(capek|lelah|sedih|sakit|khawatir|takut|cemas|sulit|berat)\b/u.test(lower)) direction = "[reassuring]";
  else if (/\b(kenapa|bagaimana|gimana|benarkah|serius\?)\b/u.test(lower) || text.endsWith("?")) direction = "[warm]";
  else if (/\b(halo|hai|selamat pagi|selamat siang|selamat sore|senang bertemu)\b/u.test(lower)) direction = "[warm]";

  return {
    text: text ? `${direction} ${text}` : "",
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
