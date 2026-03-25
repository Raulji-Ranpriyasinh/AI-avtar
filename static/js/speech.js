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

async function tts(text) {
  if (loading || currentMessage) return;
  loading = true;
  notify();
  try {
    const resp = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await resp.json();
    messages.push(...data.messages);
    if (!currentMessage && messages.length > 0) {
      currentMessage = messages[0];
    }
  } catch (err) {
    console.error("TTS error:", err);
  } finally {
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
