const BACKEND_URL = window.location.origin;

let recording = false;
let mediaRecorder = null;
let chunks = [];
let messages = [];
let currentMessage = null;
let loading = false;

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

/**
 * Parse an SSE stream from a fetch Response and push each message into
 * the playback queue.  The first message triggers playback immediately
 * while later messages queue up in the background.
 */
async function _consumeSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const parts = buffer.split("\n\n");
    // Keep the last (possibly incomplete) chunk in the buffer
    buffer = parts.pop();

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const event = JSON.parse(payload);
          const msg = event.message;
          messages.push(msg);

          // Start playback as soon as the first message arrives
          if (!currentMessage) {
            currentMessage = messages[0];
            loading = false;
            notify();
          }
        } catch (err) {
          console.error("SSE parse error:", err, payload);
        }
      }
    }
  }

  // If we never received any messages, clear the loading state
  if (loading) {
    loading = false;
    notify();
  }
}

async function tts(text) {
  if (loading || currentMessage) return;
  loading = true;
  notify();
  try {
    const resp = await fetch(`${BACKEND_URL}/tts-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!resp.ok || !resp.body) {
      // Fallback to non-streaming endpoint
      const fallback = await fetch(`${BACKEND_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await fallback.json();
      messages.push(...data.messages);
      if (!currentMessage && messages.length > 0) {
        currentMessage = messages[0];
      }
      loading = false;
      notify();
      return;
    }

    await _consumeSSEStream(resp);
  } catch (err) {
    console.error("TTS stream error:", err);
    loading = false;
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
      try {
        const resp = await fetch(`${BACKEND_URL}/sts-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio }),
        });

        if (!resp.ok || !resp.body) {
          // Fallback to non-streaming endpoint
          const fallback = await fetch(`${BACKEND_URL}/sts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: base64Audio }),
          });
          const data = await fallback.json();
          messages.push(...data.messages);
          if (!currentMessage && messages.length > 0) {
            currentMessage = messages[0];
          }
          loading = false;
          notify();
          resolve();
          return;
        }

        await _consumeSSEStream(resp);
        resolve();
      } catch (err) {
        console.error("STS stream error:", err);
        loading = false;
        notify();
        reject(err);
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
