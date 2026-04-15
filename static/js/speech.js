const BACKEND_URL = window.location.origin;

// ─── STATE ──────────────────────────────────────────────────────────────────
let messages = []; // Queue of messages ready to play (with audio)
let currentMessage = null;
let loading = false;
let recording = false;
let mediaRecorder = null;
let chunks = [];

const listeners = [];

// ─── SUBSCRIPTION SYSTEM ─────────────────────────────────────────────────────
function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribe(fn) {
  listeners.push(fn);
}

export function getState() {
  return { recording, currentMessage, loading };
}

// ─── AUDIO PLAYBACK LOGIC ────────────────────────────────────────────────────
export function onMessagePlayed() {
  console.log(`[SPEECH] 📋 Message completed.`);
  messages.shift();
  
  if (messages.length > 0) {
    currentMessage = messages[0];
    console.log(`[SPEECH] ▶️ Moving to next message in queue.`);
  } else {
    currentMessage = null;
    console.log(`[SPEECH] ✅ Queue empty.`);
  }
  notify();
}

// ─── POLLING LOGIC (The Missing Link) ────────────────────────────────────────
async function pollForAudio(requestId, index) {
  console.log(`[POLLING] Checking audio for message ${index}...`);
  
  while (true) {
    try {
      const resp = await fetch(`${BACKEND_URL}/message_ready/${requestId}/${index}`);
      const data = await resp.json();

      if (data.ready) {
        console.log(`[POLLING] ✨ Audio ready for message ${index}`);
        return data; // Returns the object with { audio, lipsync, text, etc. }
      }
      
      if (data.error) {
        console.error(`[POLLING] ❌ Backend error for message ${index}:`, data.error);
        return null;
      }
    } catch (err) {
      console.error(`[POLLING] Fetch failed for message ${index}`, err);
    }

    // Wait 300ms before polling again to avoid spamming the server
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

// ─── MAIN TTS STREAMING ──────────────────────────────────────────────────────
export async function tts(text) {
  if (loading || currentMessage) return;

  const requestId = Date.now().toString(); // Generate unique ID
  const sendTime = new Date();
  
  loading = true;
  notify();

  try {
    const resp = await fetch(`${BACKEND_URL}/tts_stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, requestId: requestId }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop(); 

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));

          if (data.type === "message") {
            console.log(`[FRONTEND] Text received: "${data.text.substring(0, 30)}..."`);
            
            // Start polling for this specific sentence's audio in the background
            pollForAudio(data.requestId, data.messageIndex).then((fullMsg) => {
              if (fullMsg) {
                // Attach the animation/expression from the original SSE if missing
                fullMsg.animation = data.animation;
                fullMsg.facialExpression = data.facialExpression;
                fullMsg.text = data.text;

                messages.push(fullMsg);

                // If nothing is playing, start the avatar now
                if (!currentMessage) {
                  currentMessage = messages[0];
                  notify();
                }
              }
            });
          }
          
          if (data.type === "done") {
            console.log(`[FRONTEND] Stream finished. Total messages: ${data.totalMessages}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("TTS Stream Error:", err);
  } finally {
    loading = false;
    notify();
  }
}

// ─── SPEECH TO SPEECH (STS) ──────────────────────────────────────────────────
async function sendAudioData(audioBlob) {
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
      
      // STS typically returns a full blocking list of messages
      messages.push(...data.messages);
      if (!currentMessage && messages.length > 0) {
        currentMessage = messages[0];
      }
    } catch (err) {
      console.error("STS error:", err);
    } finally {
      loading = false;
      notify();
    }
  };
}

// ─── MICROPHONE ──────────────────────────────────────────────────────────────
export function initMicrophone() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.onstart = () => { chunks = []; };
      mediaRecorder.ondataavailable = (e) => { chunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: "audio/webm" });
        await sendAudioData(audioBlob);
      };
    })
    .catch((err) => console.error("Microphone Access Error:", err));
}

export function startRecording() {
  if (mediaRecorder && !recording) {
    mediaRecorder.start();
    recording = true;
    notify();
  }
}

export function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
    recording = false;
    notify();
  }
}

export function stopSpeech() {
  messages = [];
  currentMessage = null;
  loading = false;
  notify();
}