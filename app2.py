import os
import json
import base64
import re
import random
import asyncio
import subprocess
import platform
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

import redis
import edge_tts
import google.generativeai as genai
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "rey_prod_secret")
socketio = SocketIO(
    app, 
    cors_allowed_origins=[
        "http://localhost:3000", 
        "http://127.0.0.1:3000",
        "http://localhost:5000", 
        "http://127.0.0.1:5000"
    ], 
    async_mode='threading'
)

# ─── Config & Pathing ──────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")
AUDIOS_DIR     = os.path.join(os.path.dirname(__file__), "audios")
BIN_DIR        = os.path.join(os.path.dirname(__file__), "bin")
RHUBARB_BIN    = os.path.join(BIN_DIR, "rhubarb.exe" if platform.system() == "Windows" else "rhubarb")

os.makedirs(AUDIOS_DIR, exist_ok=True)

# ─── Threading & Redis ──────────────────────────────────────────────────────
# Fix 5: Throttled worker pool
pipeline_executor = ThreadPoolExecutor(max_workers=3)
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)
SYSTEM_PROMPT = "You are Rey, a Medical Assistant. Max 3 sentences. Use tags like [EXPR:smile]."
# ─── Fix 4: Thread-Safe Redis Pipeline for History ─────────────────────────
def save_to_history(session_id, role, text):
    key = f"conv:{session_id}"
    try:
        pipe = redis_client.pipeline()
        pipe.rpush(key, json.dumps({"role": role, "parts": [{"text": text}]}))
        pipe.ltrim(key, -20, -1)
        pipe.expire(key, 86400)
        pipe.execute()
    except Exception as e:
        print(f"[REDIS ERROR] History write failed: {e}")

def get_history(session_id):
    key = f"conv:{session_id}"
    data = redis_client.lrange(key, 0, -1)
    return [json.loads(m) for m in data]

# ─── Fix 6: Bulletproof Pipeline with Strict Failure Checks ────────────────
def process_voice_and_emit(text, index, request_id, sid, metadata):
    filename = f"{request_id}_{index}"
    mp3_path = os.path.join(AUDIOS_DIR, f"{filename}.mp3")
    wav_path = os.path.join(AUDIOS_DIR, f"{filename}.wav")
    json_path = os.path.join(AUDIOS_DIR, f"{filename}.json")

    # Final Payload structure for both success and failure
    result_payload = {
        "requestId": request_id,
        "index": index,
        "audio": "",
        "lipsync": {"metadata": {"duration": 0}, "mouthCues": []},
        **metadata
    }

    try:
        # 1. TTS Generation
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(edge_tts.Communicate(text, EDGE_TTS_VOICE).save(mp3_path))
        loop.close()

        # 2. FFmpeg Conversion (with try/except block)
        try:
            subprocess.run(["ffmpeg", "-y", "-i", mp3_path, wav_path], 
                           capture_output=True, check=True, timeout=10)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"FFmpeg failed: {e.stderr.decode()}")

        # 3. Rhubarb Lipsync (Check if binary exists first)
        if os.path.exists(RHUBARB_BIN):
            try:
                subprocess.run([RHUBARB_BIN, "-f", "json", "-o", json_path, wav_path, "-r", "phonetic"], 
                               check=True, timeout=15)
                with open(json_path, "r") as f:
                    result_payload["lipsync"] = json.load(f)
            except Exception as e:
                print(f"[RHUBARB ERROR] {e}") # Non-fatal, just no lip movements

        # 4. Success: Prepare Audio
        with open(mp3_path, "rb") as f:
            result_payload["audio"] = base64.b64encode(f.read()).decode()

    except Exception as e:
        print(f"[PIPELINE FATAL] {e}")
        result_payload["error"] = str(e)

    finally:
        # 5. Always emit something to the frontend to keep the queue moving
        socketio.emit('audio_chunk', result_payload, to=sid)
        
        # 6. Cleanup files immediately
        for p in [mp3_path, wav_path, json_path]:
            if os.path.exists(p): 
                try: os.remove(p)
                except: pass

# ─── Intent & Core Logic ────────────────────────────────────────────────────
def detect_intent(text: str):
    text = text.lower()
    if "appointment" in text: return {"action": "scroll", "target": "appointment"}
    if "contact" in text: return {"action": "scroll", "target": "contact"}
    if "service" in text: return {"action": "scroll", "target": "services"}
    return None

def stream_and_process(user_message, session_id, request_id, sid):
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    
    history = get_history(session_id)
    if not history:
        history = [{"role": "user", "parts": [{"text": SYSTEM_PROMPT}]}]
    
    history.append({"role": "user", "parts": [{"text": user_message}]})
    save_to_history(session_id, "user", user_message)

    response = model.generate_content(history, stream=True)
    
    buffer = ""
    full_text_accumulated = ""
    index = 0
    current_expr = "default"

    for chunk in response:
        if not chunk.text: continue
        full_text_accumulated += chunk.text
        
        # Expression extraction per chunk
        expr_match = re.search(r'\[EXPR:(\w+)\]', chunk.text)
        if expr_match:
            current_expr = expr_match.group(1)
        
        buffer += re.sub(r'\[EXPR:\w+\]', '', chunk.text)

        # Robust splitting: only split on punctuation followed by a space
        if any(p in buffer for p in [". ", "! ", "? "]):
            sentences = re.split(r'(?<=[.!?])\s+', buffer)
            if len(sentences) > 1:
                for s in sentences[:-1]:
                    clean_s = s.strip()
                    if clean_s:
                        metadata = {
                            "text": clean_s,
                            "facialExpression": current_expr,
                            "animation": random.choice(["TalkingOne", "TalkingTwo"]),
                            "intent": detect_intent(clean_s)
                        }
                        # Backpressure check
                        while pipeline_executor._work_queue.qsize() > 10:
                            time.sleep(0.1)
                        
                        pipeline_executor.submit(process_voice_and_emit, clean_s, index, request_id, sid, metadata)
                        index += 1
                buffer = sentences[-1]

    # Final Flush
    if buffer.strip():
        metadata = {"text": buffer.strip(), "facialExpression": current_expr, "animation": "TalkingThree", "intent": detect_intent(buffer)}
        pipeline_executor.submit(process_voice_and_emit, buffer.strip(), index, request_id, sid, metadata)

    save_to_history(session_id, "model", re.sub(r'\[EXPR:\w+\]', '', full_text_accumulated).strip())

# ─── Socket Gateway ─────────────────────────────────────────────────────────
@socketio.on('user_message')
def handle_message(data):
    user_text = data.get('message')
    session_id = data.get('sessionId')
    request_id = f"req_{int(time.time())}"
    stream_and_process(user_text, session_id, request_id, request.sid)


@app.route("/")
def reynaindex():
    return render_template("reynaindex.html")

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=3000, debug=True)