(function (root) {
  function splitSpeechText(text, limit = 400) {
    const remaining = Array.from(String(text || "").trim());
    const chunks = [];
    const size = Math.max(1, Math.floor(Number(limit) || 400));
    let start = 0;
    while (start < remaining.length) {
      let end = Math.min(start + size, remaining.length);
      if (end < remaining.length) {
        for (let i = end - 1; i >= start + Math.floor(size / 2); i--) {
          if (/[\s.!?\u3002\uff01\uff1f\uff1b;]/u.test(remaining[i])) { end = i + 1; break; }
        }
      }
      chunks.push(remaining.slice(start, end).join(""));
      start = end;
    }
    return chunks;
  }
  const api = { splitSpeechText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DesktopPetSpeechText = api;
})(typeof window === "undefined" ? globalThis : window);
