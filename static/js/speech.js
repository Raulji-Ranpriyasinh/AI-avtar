const BACKEND_URL = window.location.origin;

let recording = false;
let mediaRecorder = null;
let chunks = [];
let messages = [];
let currentMessage = null;
let loading = false;
let sseStatus = ""; // tracks SSE status for UI: thinking, generating_audio, etc.

const listeners = [];

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.push(fn);
}

function getState() {
  return { recording, currentMessage, loading, sseStatus };
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
 * Parse an SSE stream from a fetch Response and handle events progressively.
 * The server sends events with JSON data containing a "status" field:
 *   - "thinking"        : processing has started
 *   - "generating_audio" : AI responded, audio generation begins (includes "count")
 *   - "message"          : a single audio segment ready (includes audio, lipsync, etc.)
 *   - "done"             : all segments sent
 *
 * For default / no-API-key responses the server still returns plain JSON,
 * so we detect the Content-Type and fall back gracefully.
 */
async function consumeSSEStream(response) {
  const contentType = response.headers.get("content-type") || "";

  // Fallback: if the server returned plain JSON (default messages, no API key)
  if (contentType.includes("application/json")) {
    const data = await response.json();
    messages.push(...data.messages);
    if (!currentMessage && messages.length > 0) {
      currentMessage = messages[0];
    }
    loading = false;
    sseStatus = "";
    notify();
    return;
  }

  // SSE stream
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
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Extract the data line(s)
      let jsonStr = "";
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("data: ")) {
          jsonStr += line.slice(6);
        }
      }
      if (!jsonStr) continue;

      let evt;
      try {
        evt = JSON.parse(jsonStr);
      } catch {
        console.warn("SSE parse error:", jsonStr);
        continue;
      }

      switch (evt.status) {
        case "thinking":
          sseStatus = "thinking";
          notify();
          break;

        case "generating_audio":
          sseStatus = "generating_audio";
          notify();
          break;

        case "message": {
          // Push the received message into the queue
          const msg = {
            text: evt.text,
            audio: evt.audio,
            lipsync: evt.lipsync,
            facialExpression: evt.facialExpression,
            animation: evt.animation,
          };
          messages.push(msg);
          // Start playing immediately if nothing is currently playing
          if (!currentMessage) {
            currentMessage = messages[0];
          }
          sseStatus = "playing";
          notify();
          break;
        }

        case "done":
          loading = false;
          sseStatus = "";
          notify();
          break;
      }
    }
  }

  // Ensure loading is cleared even if stream ends without "done"
  if (loading) {
    loading = false;
    sseStatus = "";
    notify();
  }
}

async function tts(text) {
  if (loading || currentMessage) return;
  loading = true;
  sseStatus = "";
  notify();
  try {
    const resp = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    await consumeSSEStream(resp);
  } catch (err) {
    console.error("TTS error:", err);
    loading = false;
    sseStatus = "";
    notify();
  }
}

async function sendAudioData(audioBlob) {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.readAsDataURL(audioBlob);
    fileReader.onloadend = async () => {
      const base64Audio = fileReader.result.split(",")[1];
      loading = true;
      sseStatus = "";
      notify();
      try {
        const resp = await fetch(`${BACKEND_URL}/sts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio }),
        });
        await consumeSSEStream(resp);
        resolve();
      } catch (err) {
        console.error("STS error:", err);
        loading = false;
        sseStatus = "";
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
