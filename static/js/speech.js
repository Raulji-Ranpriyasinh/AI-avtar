const BACKEND_URL = window.location.origin;

let recording = false;
let mediaRecorder = null;
let speechRecognition = null;
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
 * Consume an SSE stream from the server, pushing each message to the queue
 * as soon as it arrives. The avatar starts playing message 1 while
 * messages 2+ are still being generated.
 */
async function consumeSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE events in the buffer
    const parts = buffer.split("\n\n");
    // Last part may be incomplete, keep it in buffer
    buffer = parts.pop();

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const msg = JSON.parse(payload);
        messages.push(msg);
        if (!currentMessage && messages.length > 0) {
          currentMessage = messages[0];
          notify();
        }
      } catch (e) {
        console.warn("SSE parse error:", e);
      }
    }
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
    await consumeSSEStream(resp);
  } catch (err) {
    console.error("TTS error:", err);
  } finally {
    loading = false;
    notify();
  }
}

/**
 * Send pre-transcribed text (from Web Speech API) to the streaming
 * sts-stream endpoint, bypassing the Gemini transcription round-trip.
 */
async function sendTranscribedText(text) {
  loading = true;
  notify();
  try {
    const resp = await fetch(`${BACKEND_URL}/sts-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    });
    await consumeSSEStream(resp);
  } catch (err) {
    console.error("STS stream error:", err);
  } finally {
    loading = false;
    notify();
  }
}

/**
 * Fallback: send raw audio to the legacy /sts endpoint if Web Speech API
 * is not available in the browser.
 */
async function sendAudioData(audioBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
      const base64Audio = reader.result.split(",")[1];
      loading = true;
      notify();
      try {
        const resp = await fetch(`${BACKEND_URL}/sts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio }),
        });
        const data = await resp.json();
        messages.push(...data.messages);
        if (!currentMessage && messages.length > 0) {
          currentMessage = messages[0];
        }
        resolve();
      } catch (err) {
        console.error("STS error:", err);
        reject(err);
      } finally {
        loading = false;
        notify();
      }
    };
  });
}

function initMicrophone() {
  if (typeof navigator === "undefined") return;

  // Try to use Web Speech API for client-side transcription (eliminates a
  // Gemini round-trip). Falls back to MediaRecorder + server-side
  // transcription when unavailable.
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = false;
    speechRecognition.lang = "en-US";

    speechRecognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      if (transcript) {
        await sendTranscribedText(transcript);
      }
    };

    speechRecognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);
      recording = false;
      notify();
    };

    speechRecognition.onend = () => {
      recording = false;
      notify();
    };

    console.log("Using Web Speech API for client-side transcription.");
    return;
  }

  // Fallback to MediaRecorder + server-side Gemini transcription
  if (!navigator.mediaDevices) return;
  console.log(
    "Web Speech API not available. Falling back to server-side transcription."
  );
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
  if (speechRecognition && !recording) {
    speechRecognition.start();
    recording = true;
    notify();
    return;
  }
  if (mediaRecorder && !recording) {
    mediaRecorder.start();
    recording = true;
    notify();
  }
}

function stopRecording() {
  if (speechRecognition && recording) {
    speechRecognition.stop();
    recording = false;
    notify();
    return;
  }
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
