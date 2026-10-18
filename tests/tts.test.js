const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers");
const { fishSpeechStyle } = require("../src/fish-speech-style");

test("Fish speech style maps Indonesian lines to restrained supported directions", () => {
  assert.equal(fishSpeechStyle("Selamat pagi, Ferdi!").text, "[warm] Selamat pagi, Ferdi!");
  assert.equal(fishSpeechStyle("Wkwk, itu lucu banget!").text, "[chuckle] Wkwk, itu lucu banget!");
  assert.equal(fishSpeechStyle("Kamu capek hari ini?").text, "[reassuring] Kamu capek hari ini?");
  assert.equal(fishSpeechStyle("Sudah makan?").text, "[warm] Sudah makan?");
  assert.equal(fishSpeechStyle("Istirahatlah malam ini.").text, "[near-whisper] Istirahatlah malam ini.");
});

test("voice URL download shares the synthesis timeout without forwarding credentials", async () => {
  let expire;
  const requests = [];
  const app = loadMain({
    setTimeout: (callback) => { expire = callback; return 1; }, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ audio_url: "https://voice.example/clip.wav" }), { headers: { "content-type": "application/json" } });
      }
      assert.equal(options.signal, requests[0].options.signal);
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.redirect, "error");
      const waiting = new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      expire();
      return waiting;
    },
  });
  const result = await app.run('synthesizeSpeechWithSettings("hello", {tts:{enabled:true,provider:"custom",endpoint:"https://voice.example/tts",apiKey:"voice-key",customBodyTemplate:"{\\"text\\":\\"{{text}}\\"}"}})');
  assert.equal(requests.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error, "tts_timeout");
});

test("custom voice API can return audio bytes", async () => {
  const app = loadMain({ fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }) });
  const result = await app.run('synthesizeSpeechWithSettings("hello", {tts:{enabled:true,provider:"custom",endpoint:"https://voice.example/tts",customBodyTemplate:"{\\"text\\":\\"{{text}}\\"}"}})');
  assert.equal(result.ok, true);
  assert.equal(result.audioDataUrl, "data:audio/wav;base64,AQID");
});

test("Fish Audio uses the documented REST request and returns MP3 audio", async () => {
  let request;
  const app = loadMain({ fetch: async (url, options) => {
    request = { url, options };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  } });
  const result = await app.run('synthesizeSpeechWithSettings("Halo Ferdi", {tts:{enabled:true,provider:"fish",apiKey:"secret-key",referenceId:"voice-id"}})');
  assert.equal(request.url, "https://api.fish.audio/v1/tts");
  assert.equal(request.options.headers.Authorization, "Bearer secret-key");
  assert.equal(request.options.headers.model, "s2.1-pro-free");
  assert.deepEqual(JSON.parse(request.options.body), {
    text: "[warm] Halo Ferdi", reference_id: "voice-id", temperature: 0.78, top_p: 0.78,
    prosody: { speed: 0.96, volume: 0, normalize_loudness: true }, chunk_length: 220,
    condition_on_previous_chunks: true, latency: "normal", format: "mp3",
  });
  assert.equal(result.audioDataUrl, "data:audio/mpeg;base64,AQID");
});
