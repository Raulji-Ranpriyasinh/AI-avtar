import asyncio
import base64
import json
import os
import platform
import random
import re
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import edge_tts
import google.generativeai as genai
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
CORS(app)

# ─── Logging ────────────────────────────────────────────────────────────────

def log_event(event_name, details=None, start_time=None):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] {event_name}"
    if details:
        log_entry += f" | {details}"
    if start_time:
        elapsed = (datetime.now() - start_time).total_seconds()
        log_entry += f" | Elapsed: {elapsed:.3f}s"
    print(log_entry)
    return datetime.now()

# ─── Config ──────────────────────────────────────────────────────────────────

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")
AUDIOS_DIR     = os.path.join(os.path.dirname(__file__), "audios")
BIN_DIR        = os.path.join(os.path.dirname(__file__), "bin")
RHUBARB_BIN    = os.path.join(BIN_DIR, "rhubarb.exe" if platform.system() == "Windows" else "rhubarb")

pipeline_executor = ThreadPoolExecutor(max_workers=4)

# ─── GLOBAL STATE STORE ──────────────────────────────────────────────────────
# Keyed by request_id -> { index -> state_dict }
# Background workers write here; /message_ready reads here.
# For production, replace with Redis.

_sessions: dict = {}
_sessions_lock = threading.Lock()

def _get_or_create_session(request_id: str) -> dict:
    with _sessions_lock:
        if request_id not in _sessions:
            _sessions[request_id] = {}
        return _sessions[request_id]

def _cleanup_session(request_id: str):
    with _sessions_lock:
        _sessions.pop(request_id, None)

# ─── Animations ──────────────────────────────────────────────────────────────

TALKING_ANIMATIONS = ["TalkingOne", "TalkingTwo", "TalkingThree"]
GESTURE_ANIMATIONS = ["DismissingGesture", "ThoughtfulHeadShake"]

def pick_animation(index: int, total: int, prev) -> str:
    if total == 1 or index == 0 or index == total - 1:
        pool = TALKING_ANIMATIONS
    else:
        pool = TALKING_ANIMATIONS if random.random() < 0.75 else GESTURE_ANIMATIONS
    candidates = [a for a in pool if a != prev] or pool
    return random.choice(candidates)

# ─── Helpers ─────────────────────────────────────────────────────────────────

def audio_file_to_base64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

def read_json_transcript(path: str) -> dict:
    with open(path, "r") as f:
        return json.load(f)

EMPTY_LIPSYNC = {"metadata": {"duration": 0}, "mouthCues": []}

# ─── System Prompt ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are Rey, a Medical Health Expert developed by Reyna Solutions.

Stream your response as natural conversational sentences. Keep each sentence complete and self-contained.
Do NOT use JSON. Do NOT use bullet points or markdown. Just plain, fluent sentences.
Maximum 3 sentences total per response.

After each sentence, on a NEW LINE, output a facial expression tag:
[EXPR:smile] or [EXPR:sad] or [EXPR:angry] or [EXPR:surprised] or [EXPR:default]

Example:
That sounds like a common cold symptom.
[EXPR:default]
Make sure you drink plenty of fluids and rest.
[EXPR:smile]
"""

DEFAULT_RESPONSE = [{
    "text": "I'm sorry, I didn't quite understand that. Could you please repeat?",
    "facialExpression": "sad",
    "animation": "Idle",
}]

# ─── Background TTS + Lipsync Worker ─────────────────────────────────────────

def run_tts_lipsync(text: str, index: int, request_id: str):
    """
    Background worker: TTS -> WAV -> Rhubarb -> writes into the global session state.
    Runs in a ThreadPoolExecutor thread -- never blocks the SSE response.
    """
    _get_or_create_session(request_id)

    try:
        mp3_path  = os.path.join(AUDIOS_DIR, f"{request_id}_{index}.mp3")
        wav_path  = os.path.join(AUDIOS_DIR, f"{request_id}_{index}.wav")
        json_path = os.path.join(AUDIOS_DIR, f"{request_id}_{index}.json")

        # 1. TTS
        log_event(f"BG_TTS_START [{request_id}][{index}]", details=text[:50])
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(
                edge_tts.Communicate(text, EDGE_TTS_VOICE).save(mp3_path)
            )
        finally:
            loop.close()
        log_event(f"BG_TTS_DONE [{request_id}][{index}]")

        # 2. mp3 -> wav
        subprocess.run(
            ["ffmpeg", "-y", "-i", mp3_path, wav_path],
            capture_output=True, check=True
        )

        # 3. Rhubarb lip-sync
        if os.path.isfile(RHUBARB_BIN):
            result = subprocess.run(
                [RHUBARB_BIN, "-f", "json", "-o", json_path, wav_path, "-r", "phonetic"],
                capture_output=True,
            )
            if result.returncode != 0:
                log_event(f"RHUBARB_FAILED [{index}]",
                          details=result.stderr.decode(errors="replace")[:100])
                with open(json_path, "w") as f:
                    json.dump(EMPTY_LIPSYNC, f)
        else:
            with open(json_path, "w") as f:
                json.dump(EMPTY_LIPSYNC, f)

        audio_b64 = audio_file_to_base64(mp3_path)
        lipsync   = read_json_transcript(json_path)

        # Write into the GLOBAL session -- this is what /message_ready reads
        with _sessions_lock:
            if request_id in _sessions:
                _sessions[request_id][index].update({
                    "audio":        audio_b64,
                    "lipsync":      lipsync,
                    "audioReady":   True,
                    "lipsyncReady": True,
                })
        log_event(f"BG_PIPELINE_DONE [{request_id}][{index}]")

    except Exception as e:
        log_event(f"BG_PIPELINE_ERROR [{request_id}][{index}]", details=str(e))
        with _sessions_lock:
            if request_id in _sessions and index in _sessions.get(request_id, {}):
                _sessions[request_id][index].update({
                    "audio":        "",
                    "lipsync":      EMPTY_LIPSYNC,
                    "audioReady":   False,
                    "lipsyncReady": False,
                    "error":        str(e),
                })

# ─── Gemini Streaming + Sentence Splitter ────────────────────────────────────

def stream_gemini_sentences(user_message: str):
    """
    Generator -- yields (sentence, facial_expression) tuples IN REAL TIME
    as Gemini streams tokens. Does NOT buffer all sentences first.
    """
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")

    response = model.generate_content(
        [
            {"role": "user",  "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": "Understood. I will reply in plain sentences with expression tags."}]},
            {"role": "user",  "parts": [{"text": user_message}]},
        ],
        stream=True,
    )

    buffer       = ""
    current_expr = "default"

    for chunk in response:
        if not chunk.text:
            continue
        buffer += chunk.text

        # Pull out any expression tags, remember the last one
        expr_matches = re.findall(r'\[EXPR:(\w+)\]', buffer)
        if expr_matches:
            current_expr = expr_matches[-1]
            buffer = re.sub(r'\[EXPR:\w+\]\s*', '', buffer)

        # Yield every complete sentence immediately
        sentences = re.split(r'(?<=[.!?])\s+', buffer)
        if len(sentences) > 1:
            for sentence in sentences[:-1]:
                sentence = sentence.strip()
                if sentence:
                    yield sentence, current_expr
            buffer = sentences[-1]

    # Flush remaining text
    buffer = re.sub(r'\[EXPR:\w+\]\s*', '', buffer).strip()
    if buffer:
        yield buffer, current_expr

# ─── /tts_stream  (main SSE endpoint) ────────────────────────────────────────

@app.route("/tts_stream", methods=["POST"])
def tts_stream():
    data         = request.get_json()
    user_message = data.get("message", "")
    # Unique ID for this request -- frontend must send this back when polling
    request_id   = data.get("requestId") or datetime.now().strftime("%Y%m%d%H%M%S%f")
    log_event("tts_stream REQUEST", details=f"id={request_id} msg={user_message[:60]}")

    # Initialise the session slot in the global store
    _get_or_create_session(request_id)

    def generate():
        request_start  = datetime.now()
        prev_animation = None
        index          = 0
        try:
            for sentence, expr in stream_gemini_sentences(user_message):
                animation      = pick_animation(index, 99, prev_animation)
                prev_animation = animation

                # Register this message in global state BEFORE firing background task
                with _sessions_lock:
                    _sessions[request_id][index] = {
                        "text":             sentence,
                        "facialExpression": expr,
                        "animation":        animation,
                        "messageIndex":     index,
                        "audioReady":       False,
                        "lipsyncReady":     False,
                    }

                # Push text to frontend immediately -- no audio yet
                payload = {
                    "type":             "message",
                    "requestId":        request_id,
                    "text":             sentence,
                    "facialExpression": expr,
                    "animation":        animation,
                    "messageIndex":     index,
                    "audioReady":       False,
                }
                log_event(f"SSE TEXT SENT [{index}]", details=sentence[:50])
                yield f"data: {json.dumps(payload)}\n\n"

                # Fire background TTS+lipsync -- writes to global session state
                pipeline_executor.submit(run_tts_lipsync, sentence, index, request_id)

                index += 1

        except Exception as e:
            log_event("SSE STREAM ERROR", details=str(e))
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"

        # Send "done" event so frontend knows the total count
        yield f"data: {json.dumps({'type': 'done', 'requestId': request_id, 'totalMessages': index})}\n\n"
        log_event("SSE STREAM DONE", details=f"{index} messages", start_time=request_start)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# ─── /message_ready  (frontend polls for audio + lipsync) ────────────────────

@app.route("/message_ready/<request_id>/<int:index>", methods=["GET"])
def message_ready(request_id: str, index: int):
    """
    Frontend polls this after receiving an SSE text event.
    Returns audio+lipsync JSON when the background worker is done.

    URL: GET /message_ready/<requestId>/<messageIndex>
    """
    with _sessions_lock:
        session = _sessions.get(request_id, {})
        state   = session.get(index)

    if not state:
        return jsonify({"ready": False, "reason": "not_found"})

    if state.get("audioReady") and state.get("lipsyncReady"):
        return jsonify({
            "ready":        True,
            "audio":        state["audio"],
            "lipsync":      state["lipsync"],
            "messageIndex": index,
            "requestId":    request_id,
        })

    if "error" in state:
        # Background pipeline failed -- tell frontend to skip audio for this message
        return jsonify({
            "ready":        True,
            "audio":        "",
            "lipsync":      EMPTY_LIPSYNC,
            "messageIndex": index,
            "error":        state["error"],
        })

    return jsonify({"ready": False})

# ─── /session_cleanup  (frontend calls when done playing) ────────────────────

@app.route("/session_cleanup/<request_id>", methods=["DELETE"])
def session_cleanup(request_id: str):
    _cleanup_session(request_id)
    return jsonify({"ok": True})

# ─── /tts  (non-streaming fallback) ──────────────────────────────────────────

SYSTEM_PROMPT_JSON = """You are Rey, a Medical Health Expert developed by Reyna Solutions.
Respond ONLY with valid JSON:
{"messages": [{"text": "...", "facialExpression": "smile"}]}
Max 3 messages. Expressions: smile, sad, angry, surprised, default."""

@app.route("/tts", methods=["POST"])
def tts():
    data         = request.get_json()
    user_message = data.get("message", "")

    if not user_message:
        return jsonify({"messages": _default_intro_messages()})
    if not GEMINI_API_KEY:
        return jsonify({"messages": DEFAULT_RESPONSE})

    try:
        ai_messages = _chat_with_gemini_json(user_message)
    except Exception as e:
        log_event("GEMINI_ERROR", details=str(e))
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = _process_lip_sync_blocking(ai_messages)
    return jsonify({"messages": ai_messages})

# ─── /sts  (speech-to-speech) ────────────────────────────────────────────────

@app.route("/sts", methods=["POST"])
def sts():
    data         = request.get_json()
    base64_audio = data.get("audio", "")
    audio_bytes  = base64.b64decode(base64_audio)

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_in = tmp.name
    tmp_out = tmp_in.replace(".webm", ".wav")

    user_message = ""
    try:
        subprocess.run(["ffmpeg", "-y", "-i", tmp_in, tmp_out], capture_output=True, check=True)
        if GEMINI_API_KEY:
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel("gemini-2.5-flash")
            with open(tmp_out, "rb") as af:
                audio_data = af.read()
            resp = model.generate_content([
                "Transcribe this audio. Return ONLY the transcribed text.",
                {"mime_type": "audio/wav", "data": audio_data},
            ])
            user_message = resp.text.strip()
    finally:
        for p in (tmp_in, tmp_out):
            if os.path.exists(p):
                os.unlink(p)

    if not user_message:
        return jsonify({"messages": DEFAULT_RESPONSE})

    try:
        ai_messages = _chat_with_gemini_json(user_message)
    except Exception as e:
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = _process_lip_sync_blocking(ai_messages)
    return jsonify({"messages": ai_messages})

# ─── /voices ─────────────────────────────────────────────────────────────────

@app.route("/voices", methods=["GET"])
def get_voices():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    voices = loop.run_until_complete(edge_tts.list_voices())
    loop.close()
    return jsonify(voices)

# ─── Pages ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/reynaindex")
def reynaindex():
    return render_template("reynaindex.html")

# ─── Internal helpers ────────────────────────────────────────────────────────

def _default_intro_messages():
    def _load(name):
        return {
            "audio":   audio_file_to_base64(os.path.join(AUDIOS_DIR, f"{name}.wav")),
            "lipsync": read_json_transcript(os.path.join(AUDIOS_DIR, f"{name}.json")),
        }
    return [
        {**_load("intro_0"), "text": "Hey there... How was your day?",
         "facialExpression": "smile", "animation": "TalkingOne"},
        {**_load("intro_1"), "text": "I'm Rey, your personal Medical assistant.",
         "facialExpression": "smile", "animation": "TalkingTwo"},
    ]

def _chat_with_gemini_json(user_message: str) -> list:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content([
        {"role": "user",  "parts": [{"text": SYSTEM_PROMPT_JSON}]},
        {"role": "model", "parts": [{"text": '{"messages":[{"text":"Hello!","facialExpression":"smile"}]}'}]},
        {"role": "user",  "parts": [{"text": user_message}]},
    ])
    text = re.sub(r"^```json|^```|```$", "", response.text.strip(), flags=re.MULTILINE).strip()
    messages = json.loads(text).get("messages", list(DEFAULT_RESPONSE))
    prev = None
    for i, msg in enumerate(messages):
        anim = pick_animation(i, len(messages), prev)
        msg["animation"] = anim
        prev = anim
    return messages

def _process_lip_sync_blocking(messages: list) -> list:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    async def _all_tts():
        await asyncio.gather(*[
            edge_tts.Communicate(m["text"], EDGE_TTS_VOICE).save(
                os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
            )
            for i, m in enumerate(messages)
        ])
    loop.run_until_complete(_all_tts())
    loop.close()

    for i, msg in enumerate(messages):
        try:
            mp3 = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
            wav = os.path.join(AUDIOS_DIR, f"message_{i}.wav")
            jsn = os.path.join(AUDIOS_DIR, f"message_{i}.json")
            subprocess.run(["ffmpeg", "-y", "-i", mp3, wav], capture_output=True, check=True)
            if os.path.isfile(RHUBARB_BIN):
                r = subprocess.run(
                    [RHUBARB_BIN, "-f", "json", "-o", jsn, wav, "-r", "phonetic"],
                    capture_output=True,
                )
                if r.returncode != 0:
                    with open(jsn, "w") as f:
                        json.dump(EMPTY_LIPSYNC, f)
            else:
                with open(jsn, "w") as f:
                    json.dump(EMPTY_LIPSYNC, f)
            msg["audio"]   = audio_file_to_base64(mp3)
            msg["lipsync"] = read_json_transcript(jsn)
        except Exception as e:
            log_event(f"LIPSYNC_ERROR [{i}]", details=str(e))
            msg["audio"]   = ""
            msg["lipsync"] = EMPTY_LIPSYNC
    return messages

# ─── Entry ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(AUDIOS_DIR, exist_ok=True)
    os.makedirs(BIN_DIR,    exist_ok=True)
    app.run(host="0.0.0.0", port=3000, debug=True)