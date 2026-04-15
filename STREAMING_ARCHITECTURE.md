# 🚀 High-Performance Streaming Architecture

## Overview

This document explains the optimized streaming architecture that eliminates audio overlap and delivers messages as soon as they're ready.

---

## 🎯 Key Improvements

### 1. **Sequential Message Streaming (NO AUDIO OVERLAP)**
- ✅ **Before**: All messages processed → Then all streamed at once
- ✅ **After**: Each message processed → Streamed immediately → Next message starts
- ✅ **Result**: Audio 1 completes BEFORE Audio 2 starts

### 2. **Per-Message Processing Pipeline**
```
Message 0: Gemini → TTS → Lip-Sync → Stream → PLAY
Message 1: TTS → Lip-Sync → Stream → (waits for Message 0 to finish) → PLAY
Message 2: TTS → Lip-Sync → Stream → (waits for Message 1 to finish) → PLAY
```

### 3. **Backend Changes (`app.py`)**

#### Streaming Endpoint (`/tts_stream`)
```python
for i in range(num_messages):
    # Process THIS message only
    await convert_text_to_speech(msg["text"], mp3_path)
    generate_lip_sync(i)
    
    # Stream IMMEDIATELY when ready
    yield f"data: {json.dumps(msg)}\n\n"
    
    # Move to NEXT message
```

**Key Features:**
- Processes messages **sequentially** (not all at once)
- Streams each message as soon as TTS + lip-sync are complete
- Includes message index and total count for frontend tracking
- Comprehensive logging at each step

#### Animation Assignment
- Simplified Gemini prompt (no animation selection)
- Natural animation assignment with variety:
  - 75% talking animations (TalkingOne, TalkingTwo, TalkingThree)
  - 25% gesture animations (DismissingGesture, ThoughtfulHeadShake)
  - Never repeats same animation consecutively

---

### 4. **Frontend Changes (`speech.js` + `avatar.js`)**

#### Message Reception (`speech.js`)
```javascript
while (streaming) {
    const msg = receive_message();
    messages.push(msg);  // Add to queue
    
    if (!currently_playing) {
        currentMessage = messages[0];  // Start playing
    }
}
```

#### Sequential Playback (`avatar.js`)
```javascript
function onSpeechUpdate() {
    // ENSURE previous audio is stopped
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    
    // Play NEW message
    audio.play();
    audio.onended = () => {
        onMessagePlayed();  // Triggers NEXT message in queue
    };
}
```

#### Queue Management (`speech.js`)
```javascript
function onMessagePlayed() {
    messages.shift();  // Remove played message
    if (messages.length > 0) {
        currentMessage = messages[0];  // Start next
    }
}
```

---

## 📊 Performance Metrics

### Logging System

Every operation is logged with timestamps:

**Backend Console:**
```
[2026-04-15 10:30:15.123] REQUEST_RECEIVED | tts_stream endpoint called
[2026-04-15 10:30:15.125] USER_MESSAGE | Message: What are the symptoms of flu?
[2026-04-15 10:30:15.126] PROCESSING_START | Starting streaming pipeline
[2026-04-15 10:30:15.127] GEMINI_REQUEST | User message: What are the symptoms...
[2026-04-15 10:30:17.456] GEMINI_RESPONSE | Generated 3 messages | Elapsed: 2.329s
[2026-04-15 10:30:17.458] MESSAGE_0_START | Processing message 1/3
[2026-04-15 10:30:17.459] TTS_START | Text: Common symptoms include...
[2026-04-15 10:30:18.234] TTS_COMPLETE | Saved to: ... | Elapsed: 0.775s
[2026-04-15 10:30:18.235] LIPSYNC_START | Processing message 0
[2026-04-15 10:30:19.012] LIPSYNC_COMPLETE | Message 0 processed | Elapsed: 0.777s
[2026-04-15 10:30:19.013] MESSAGE_0_STREAMING | Streaming message 1/3
[2026-04-15 10:30:19.014] MESSAGE_0_COMPLETE | Message 1 streamed | Elapsed: 1.556s
[2026-04-15 10:30:19.015] MESSAGE_1_START | Processing message 2/3
...
```

**Frontend Console:**
```
[FRONTEND] User sent message: "What are the symptoms of flu?"
[FRONTEND] ⚡ First message received | Latency: 3891ms
[FRONTEND] 📨 Message 1/3 received: "Common symptoms include..."
[FRONTEND] Animation: TalkingTwo, Expression: default
[FRONTEND] ▶️ Starting playback of message 1
[AVATAR] ▶️ Playing message 1/3 | Animation: TalkingTwo | Expression: default
[AVATAR] ✅ Message 1/3 playback completed
[SPEECH] 📋 Message played, removing from queue. Remaining: 2
[SPEECH] ▶️ Starting next message in queue
[AVATAR] ▶️ Playing message 2/3 | Animation: DismissingGesture | Expression: smile
...
```

---

## 🎬 Message Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ USER sends message                                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ BACKEND: chat_with_gemini()                                  │
│ - Generates 3 messages with facial expressions               │
│ - assign_natural_animation() adds animations                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE 0 Processing                                         │
│ 1. TTS generation (async)                                    │
│ 2. Lip-sync generation (ffmpeg + rhubarb)                    │
│ 3. Load audio + lipsync data                                 │
│ 4. STREAM to frontend immediately                            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE 1 Processing (starts after Message 0 streamed)       │
│ 1. TTS generation                                            │
│ 2. Lip-sync generation                                       │
│ 3. Load audio + lipsync data                                 │
│ 4. STREAM to frontend                                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE 2 Processing (starts after Message 1 streamed)       │
│ 1. TTS generation                                            │
│ 2. Lip-sync generation                                       │
│ 3. Load audio + lipsync data                                 │
│ 4. STREAM to frontend                                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ FRONTEND: Message Queue                                      │
│ messages = [msg0, msg1, msg2]                                │
│ - msg0 arrives → start playing immediately                   │
│ - msg1 arrives → wait in queue                               │
│ - msg2 arrives → wait in queue                               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ PLAYBACK (Sequential - NO OVERLAP)                           │
│ 1. Play msg0.audio                                           │
│ 2. onended() → remove msg0, start msg1                       │
│ 3. onended() → remove msg1, start msg2                       │
│ 4. onended() → queue empty, idle                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔒 Audio Overlap Prevention

### Mechanism 1: Sequential Backend Processing
- Messages are processed **one at a time** in a loop
- Message `i+1` doesn't start until message `i` is streamed
- Natural pacing: each message must complete before next begins

### Mechanism 2: Frontend Queue System
```javascript
// In avatar.js - ENSURE clean slate before playing
if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
}

// Play new audio
audio.play();
audio.onended = () => {
    onMessagePlayed();  // Triggers NEXT in queue
};
```

### Mechanism 3: Queue Management
```javascript
function onMessagePlayed() {
    messages.shift();  // Remove CURRENT message
    if (messages.length > 0) {
        currentMessage = messages[0];  // Start NEXT message
    }
}
```

**Result**: Audio 1 → (completes) → Audio 2 → (completes) → Audio 3 → (completes) → Done

---

## 🎯 Benefits

### 1. **Faster First Response**
- User sees avatar start talking sooner
- First message streams as soon as it's ready
- No waiting for all messages to process

### 2. **No Audio Overlap**
- Guaranteed sequential playback
- Clean audio transitions
- Professional user experience

### 3. **Better Resource Usage**
- Process only what's needed
- Stream incrementally
- Less memory pressure

### 4. **Observable Performance**
- Detailed logging at every step
- Track latency from user input to first response
- Monitor TTS and lip-sync processing times

---

## 🚀 Future Optimizations

### Phase 1: ✅ **DONE** (Current)
- Sequential streaming
- Natural animations
- Comprehensive logging

### Phase 2: Parallel Processing
- Pre-generate TTS for next message while current plays
- Background lip-sync processing
- Pipeline architecture

### Phase 3: Gemini Streaming
- Use `model.generate_content(stream=True)`
- Start TTS on partial text
- Token-by-token processing

### Phase 4: Advanced Caching
- Cache common responses
- Pre-compute frequent queries
- Voice caching with variable speed

---

## 📝 Code Locations

| Component | File | Function |
|-----------|------|----------|
| Streaming endpoint | `app.py` | `tts_stream()` |
| TTS generation | `app.py` | `convert_text_to_speech()` |
| Lip-sync | `app.py` | `generate_lip_sync()` |
| Animation assignment | `app.py` | `assign_natural_animation()` |
| Message queue | `speech.js` | `tts()`, `onMessagePlayed()` |
| Audio playback | `avatar.js` | `onSpeechUpdate()` |

---

## 🧪 Testing

To verify no audio overlap:
1. Open browser console (F12)
2. Send a message that generates multiple responses
3. Watch the logs - you should see:
   ```
   [AVATAR] ▶️ Playing message 1/3
   [AVATAR] ✅ Message 1/3 playback completed
   [AVATAR] ▶️ Playing message 2/3  ← Only AFTER message 1 completes
   [AVATAR] ✅ Message 2/3 playback completed
   [AVATAR] ▶️ Playing message 3/3  ← Only AFTER message 2 completes
   ```

4. Check backend logs for processing times
5. Verify sequential order in console

---

## 🎓 Key Concepts

### Streaming vs Batch Processing
- **Batch**: Process ALL → Send ALL (slow, wasteful)
- **Streaming**: Process ONE → Send ONE → Repeat (fast, efficient)

### Sequential vs Parallel Audio
- **Parallel**: All audios play together (chaos!)
- **Sequential**: Audio 1 → Audio 2 → Audio 3 (clean)

### Queue System
- Messages arrive at different times
- Queue holds them until ready to play
- Each message plays only after previous completes

---

**Last Updated**: 2026-04-15  
**Version**: 2.0 (High-Performance Streaming)
