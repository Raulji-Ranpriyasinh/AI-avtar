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
  console.log(`[SPEECH] 📋 Message played, removing from queue. Remaining: ${messages.length - 1}`);
  messages.shift();
  if (messages.length > 0) {
    currentMessage = messages[0];
    console.log(`[SPEECH] ▶️ Starting next message in queue`);
  } else {
    currentMessage = null;
    console.log(`[SPEECH] ✅ All messages completed, queue empty`);
  }
  notify();
}

// async function tts(text) {
//   if (loading || currentMessage) return;
//   loading = true;
//   notify();
//   try {
//     const resp = await fetch(`${BACKEND_URL}/tts`, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ message: text }),
//     });
//     const data = await resp.json();
//     messages.push(...data.messages);
//     if (!currentMessage && messages.length > 0) {
//       currentMessage = messages[0];
//     }
//   } catch (err) {
//     console.error("TTS error:", err);
//   } finally {
//     loading = false;
//     notify();
//   }
// }

async function tts(text) {
  if (loading || currentMessage) return;

  const sendTime = new Date();
  console.log(`[FRONTEND] [${sendTime.toISOString()}] User sent message: "${text}"`);
  
  loading = true;
  notify();

  try {
    const resp = await fetch(`${BACKEND_URL}/tts_stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Timestamp": sendTime.toISOString()
      },
      body: JSON.stringify({ message: text, clientTimestamp: sendTime.toISOString() }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstMessageTime = null;
    let messagesReceived = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop(); // keep incomplete chunk

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const msg = JSON.parse(line.slice(6));
          messagesReceived++;
          
          if (!firstMessageTime) {
            firstMessageTime = new Date();
            const latency = firstMessageTime - sendTime;
            console.log(`[FRONTEND] [${firstMessageTime.toISOString()}] ⚡ First message received | Latency: ${latency}ms`);
            
            // Update latency display in UI
            const latencyEl = document.getElementById("latency-display");
            if (latencyEl) {
              latencyEl.textContent = `⏱️ First response: ${latency}ms`;
              if (latency < 1000) {
                latencyEl.style.color = "#4caf50"; // Green for fast
              } else if (latency < 2000) {
                latencyEl.style.color = "#ff9800"; // Orange for moderate
              } else {
                latencyEl.style.color = "#f44336"; // Red for slow
              }
            }
          }

          // Add to message queue - avatar.js will play them sequentially
          messages.push(msg);
          
          const msgIndex = msg.messageIndex !== undefined ? msg.messageIndex : messagesReceived - 1;
          const totalMsgs = msg.totalMessages || 1;
          
          console.log(`[FRONTEND] [${new Date().toISOString()}] 📨 Message ${msgIndex + 1}/${totalMsgs} received: "${msg.text.substring(0, 50)}..."`);
          console.log(`[FRONTEND] Animation: ${msg.animation}, Expression: ${msg.facialExpression}`);

          // Start playing immediately when first message arrives
          if (!currentMessage && messages.length === 1) {
            currentMessage = messages[0];
            loading = false; // unblock UI for next user input
            console.log(`[FRONTEND] ▶️ Starting playback of message 1`);
          }
          
          notify();
        }
      }
    }
    
    const completeTime = new Date();
    const totalLatency = completeTime - sendTime;
    console.log(`[FRONTEND] [${completeTime.toISOString()}] ✅ All ${messagesReceived} messages received | Total latency: ${totalLatency}ms`);
    console.log(`[FRONTEND] Messages will play sequentially without overlap`);
  } catch (err) {
    console.error("TTS stream error:", err);
  } finally {
    loading = false;
    notify();
  }
}
async function sendAudioData(audioBlob) {
  return new Promise((resolve, reject) => {
    const sendTime = new Date();
    console.log(`[FRONTEND] [${sendTime.toISOString()}] Audio sent to STS endpoint`);
    
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
        const receiveTime = new Date();
        const latency = receiveTime - sendTime;
        console.log(`[FRONTEND] [${receiveTime.toISOString()}] STS response received | Latency: ${latency}ms`);
        
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
