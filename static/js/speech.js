const BACKEND_URL = window.location.origin;

let recording = false;
let mediaRecorder = null;
let chunks = [];
let messages = [];
let currentMessage = null;
let loading = false;
let streamAbortController = null;

const listeners = [];

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.push(fn);
}

function getState() {
  return { recording, currentMessage, loading };
}

function onMessagePlayed() {
  messages.shift();
  if (messages.length > 0) {
    currentMessage = messages[0];
  } else {
    currentMessage = null;
  }
  notify();
}

async function processSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const msg = JSON.parse(payload);
          messages.push(msg);
          if (!currentMessage) {
            currentMessage = messages[0];
            loading = false;
            notify();
          }
        } catch (e) {
          // ignore malformed SSE events
        }
      }
    }
  }
}

async function tts(text) {
  if (loading || currentMessage) return;
  loading = true;
  notify();
  streamAbortController = new AbortController();
  try {
    const resp = await fetch(`${BACKEND_URL}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: streamAbortController.signal,
    });
    await processSSEStream(resp);
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("TTS error:", err);
    }
  } finally {
    loading = false;
    streamAbortController = null;
    notify();
  }
}

async function sendAudioData(audioBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
      const base64Audio = reader.result.split(",")[1];
      loading = true;
      notify();
      streamAbortController = new AbortController();
      try {
        const resp = await fetch(`${BACKEND_URL}/sts/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio }),
          signal: streamAbortController.signal,
        });
        await processSSEStream(resp);
        resolve();
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("STS error:", err);
          reject(err);
        } else {
          resolve();
        }
      } finally {
        loading = false;
        streamAbortController = null;
        notify();
      }
    };
  });
}

function initMicrophone() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.onstart = () => {
        chunks = [];
      };
      mediaRecorder.ondataavailable = (e) => {
        chunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: "audio/webm" });
        try {
          await sendAudioData(audioBlob);
        } catch (err) {
          console.error(err);
        }
      };
    })
    .catch((err) => console.error("Error accessing microphone:", err));
}

function startRecording() {
  if (mediaRecorder && !recording) {
    mediaRecorder.start();
    recording = true;
    notify();
  }
}

function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
    recording = false;
    notify();
  }
}

function stopSpeech() {
  if (streamAbortController) {
    streamAbortController.abort();
    streamAbortController = null;
  }
  messages = [];
  currentMessage = null;
  loading = false;
  notify();
}

export {
  subscribe,
  getState,
  onMessagePlayed,
  tts,
  startRecording,
  stopRecording,
  stopSpeech,
  initMicrophone,
};
