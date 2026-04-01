import asyncio
import base64
import json
import logging
import os
import platform
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import edge_tts
import google.generativeai as genai
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from flask_cors import CORS

load_dotenv()

# ── Logging setup ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("avatar-perf")

app = Flask(__name__)
CORS(app)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")

# Initialize Gemini model once at startup
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel("gemini-2.0-flash")
else:
    gemini_model = None

AUDIOS_DIR = os.path.join(os.path.dirname(__file__), "audios")
BIN_DIR = os.path.join(os.path.dirname(__file__), "bin")
if platform.system() == "Windows":
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb.exe")
else:
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb")

SYSTEM_PROMPT = """You are Rey a Medical Health Expert Developed by reyna Solutions.
You will always respond with a JSON array of messages, with a maximum of 1 message.
Only use multiple messages (up to 3) when the topic truly requires a multi-part explanation.
Each message has properties for text, facialExpression, and animation.
The different facial expressions are: smile, sad, angry, surprised, and default.
The different animations are: Idle, TalkingOne, TalkingTwo, TalkingThree,
DismissingGesture and ThoughtfulHeadShake.

IMPORTANT animation guidelines:
- Use DIFFERENT animations for each message in your response. Never repeat the same animation
  in consecutive messages.
- Vary between TalkingOne, TalkingTwo, and TalkingThree for general conversation.
- Use DismissingGesture for dismissing misconceptions or myths.
- Use ThoughtfulHeadShake for disagreeing or correcting information.
- Use Idle only when the avatar should pause briefly between thoughts.
- For multi-message responses, create a natural flow: e.g. start with a gesture, then talk,
  then settle into an idle.

Respond ONLY with valid JSON in this exact format:
{
  "messages": [
    {
      "text": "Your response text here",
      "facialExpression": "smile",
      "animation": "TalkingOne"
    }
  ]
}"""

DEFAULT_RESPONSE = [
    {
        "text": "I'm sorry, there seems to be an error with my brain, or I didn't understand. Could you please repeat your question?",
        "facialExpression": "sad",
        "animation": "Idle",
    }
]


def audio_file_to_base64(file_path):
    with open(file_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def read_json_transcript(file_path):
    with open(file_path, "r") as f:
        return json.load(f)


def get_default_messages(user_message):
    if not user_message:
        return [
            {
                "text": "Hey there... How was your day?",
                "audio": audio_file_to_base64(os.path.join(AUDIOS_DIR, "intro_0.wav")),
                "lipsync": read_json_transcript(os.path.join(AUDIOS_DIR, "intro_0.json")),
                "facialExpression": "smile",
                "animation": "TalkingOne",
            },
            {
                "text": "I'm Rey, your personal Medical assistant. I'm here to help you with anything you need.",
                "audio": audio_file_to_base64(os.path.join(AUDIOS_DIR, "intro_1.wav")),
                "lipsync": read_json_transcript(os.path.join(AUDIOS_DIR, "intro_1.json")),
                "facialExpression": "smile",
                "animation": "TalkingOne",
            },
        ]

    if not GEMINI_API_KEY:
        return [
            {
                "text": "Please my friend, don't forget to add your API keys!",
                "audio": audio_file_to_base64(os.path.join(AUDIOS_DIR, "api_0.wav")),
                "lipsync": read_json_transcript(os.path.join(AUDIOS_DIR, "api_0.json")),
                "facialExpression": "angry",
                "animation": "TalkingOne",
            },
        ]

    return None


def chat_with_gemini(user_message):
    if not gemini_model:
        logger.warning("Gemini model not initialized (no API key). Returning default response.")
        return list(DEFAULT_RESPONSE)
    t0 = time.perf_counter()
    response = gemini_model.generate_content(
        [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": '{"messages": [{"text": "Hello!", "facialExpression": "smile", "animation": "TalkingOne"}]}'}]},
            {"role": "user", "parts": [{"text": user_message}]},
        ]
    )
    elapsed = time.perf_counter() - t0
    logger.info("[Gemini API] generate_content took %.3fs", elapsed)
    text = response.text.strip()
    if text.startswith("```json"):
        text = text[7:]
    if text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    parsed = json.loads(text)
    messages = parsed.get("messages", DEFAULT_RESPONSE)
    logger.info("[Gemini API] Returned %d message(s), total Gemini time: %.3fs", len(messages), elapsed)
    return messages


async def convert_text_to_speech(text, output_path):
    t0 = time.perf_counter()
    communicate = edge_tts.Communicate(text, EDGE_TTS_VOICE)
    await communicate.save(output_path)
    elapsed = time.perf_counter() - t0
    logger.info("[TTS] edge-tts for '%s' -> %s took %.3fs", text[:50], os.path.basename(output_path), elapsed)


def generate_lip_sync(message_index):
    mp3_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.mp3")
    wav_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.wav")
    json_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.json")

    t0 = time.perf_counter()
    subprocess.run(
        ["ffmpeg", "-y", "-i", mp3_path, wav_path],
        capture_output=True,
        check=True,
    )
    ffmpeg_time = time.perf_counter() - t0
    logger.info("[LipSync] ffmpeg mp3->wav for message_%d took %.3fs", message_index, ffmpeg_time)

    if os.path.isfile(RHUBARB_BIN):
        t1 = time.perf_counter()
        result = subprocess.run(
            [RHUBARB_BIN, "-f", "json", "-o", json_path, wav_path, "-r", "phonetic"],
            capture_output=True,
        )
        rhubarb_time = time.perf_counter() - t1
        if result.returncode != 0:
            logger.warning("[LipSync] Rhubarb FAILED for message_%d (exit %d) in %.3fs",
                           message_index, result.returncode, rhubarb_time)
            if result.stderr:
                logger.warning("Rhubarb stderr: %s", result.stderr.decode(errors='replace'))
            if result.stdout:
                logger.warning("Rhubarb stdout: %s", result.stdout.decode(errors='replace'))
            empty_lipsync = {"metadata": {"duration": 0}, "mouthCues": []}
            with open(json_path, "w") as f:
                json.dump(empty_lipsync, f)
        else:
            logger.info("[LipSync] Rhubarb for message_%d took %.3fs", message_index, rhubarb_time)
    else:
        logger.warning("[LipSync] Rhubarb binary not found at %s. Lip sync will be empty.", RHUBARB_BIN)
        empty_lipsync = {"metadata": {"duration": 0}, "mouthCues": []}
        with open(json_path, "w") as f:
            json.dump(empty_lipsync, f)

    total_lipsync = time.perf_counter() - t0
    logger.info("[LipSync] Total lip-sync for message_%d: %.3fs (ffmpeg=%.3fs)",
                message_index, total_lipsync, ffmpeg_time)


def run_tts_for_message(i, text):
    """Run TTS only for message i. Returns when mp3 is saved to disk."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    output_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
    loop.run_until_complete(convert_text_to_speech(text, output_path))
    loop.close()
    return i


def run_lipsync_and_attach(i, msg):
    """Run lip-sync (ffmpeg + rhubarb) and attach audio + lipsync data to msg."""
    t0 = time.perf_counter()
    generate_lip_sync(i)
    mp3_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
    json_path = os.path.join(AUDIOS_DIR, f"message_{i}.json")
    msg["audio"] = audio_file_to_base64(mp3_path)
    msg["lipsync"] = read_json_transcript(json_path)
    elapsed = time.perf_counter() - t0
    logger.info("[Pipeline] LipSync+attach for message_%d completed in %.3fs", i, elapsed)
    return i


def process_lip_sync(messages):
    """Pipeline TTS and lip-sync: start all TTS concurrently, then start each
    message's lip-sync as soon as its TTS finishes (overlapping with other TTS
    jobs still running)."""
    pipeline_start = time.perf_counter()
    logger.info("[Pipeline] process_lip_sync START for %d message(s) (pipelined)", len(messages))

    with ThreadPoolExecutor(max_workers=max(len(messages) * 2, 3)) as executor:
        # Phase 1: Submit all TTS jobs concurrently
        tts_futures = {}
        for i, msg in enumerate(messages):
            f = executor.submit(run_tts_for_message, i, msg["text"])
            tts_futures[f] = i

        # Phase 2: As each TTS completes, immediately start its lip-sync
        lip_futures = {}
        for completed_f in as_completed(tts_futures):
            i = tts_futures[completed_f]
            try:
                completed_f.result()
                logger.info("[Pipeline] TTS for message_%d done, starting lip-sync immediately", i)
                lip_f = executor.submit(run_lipsync_and_attach, i, messages[i])
                lip_futures[i] = lip_f
            except Exception as e:
                logger.error("[Pipeline] TTS failed for message %d: %s", i, e)
                messages[i]["audio"] = ""
                messages[i]["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

        # Phase 3: Wait for all lip-sync jobs
        for i, f in lip_futures.items():
            try:
                f.result()
            except Exception as e:
                logger.error("[Pipeline] LipSync failed for message %d: %s", i, e)
                messages[i]["audio"] = ""
                messages[i]["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

    total = time.perf_counter() - pipeline_start
    logger.info("[Pipeline] process_lip_sync DONE in %.3fs (pipelined TTS+LipSync)", total)
    return messages


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/reynaindex")
def reynaindex():
    return render_template("reynaindex.html")


@app.route("/voices", methods=["GET"])
def get_voices():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    voices = loop.run_until_complete(edge_tts.list_voices())
    loop.close()
    return jsonify(voices)


@app.route("/tts", methods=["POST"])
def tts():
    request_start = time.perf_counter()
    data = request.get_json()
    user_message = data.get("message", "")
    logger.info("[/tts] Request received: '%s'", user_message[:80])

    default_msgs = get_default_messages(user_message)
    if default_msgs is not None:
        return jsonify({"messages": default_msgs})

    try:
        t0 = time.perf_counter()
        ai_messages = chat_with_gemini(user_message)
        logger.info("[/tts] Gemini call took %.3fs", time.perf_counter() - t0)
    except Exception as e:
        logger.error("[/tts] Gemini API error: %s", e)
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = process_lip_sync(ai_messages)

    total = time.perf_counter() - request_start
    logger.info("[/tts] Total request time: %.3fs", total)
    return jsonify({"messages": ai_messages})


@app.route("/tts-stream", methods=["POST"])
def tts_stream():
    """SSE endpoint that streams each message as soon as its audio/lipsync is ready."""
    request_start = time.perf_counter()
    data = request.get_json()
    user_message = data.get("message", "")
    logger.info("[/tts-stream] Request received: '%s'", user_message[:80])

    default_msgs = get_default_messages(user_message)
    if default_msgs is not None:
        def generate_default():
            for msg in default_msgs:
                yield f"data: {json.dumps(msg)}\n\n"
            yield "data: [DONE]\n\n"
        return Response(
            stream_with_context(generate_default()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        t0 = time.perf_counter()
        ai_messages = chat_with_gemini(user_message)
        logger.info("[/tts-stream] Gemini call took %.3fs", time.perf_counter() - t0)
    except Exception as e:
        logger.error("[/tts-stream] Gemini API error: %s", e)
        ai_messages = list(DEFAULT_RESPONSE)

    def generate():
        with ThreadPoolExecutor(max_workers=max(len(ai_messages), 3)) as executor:
            # Start ALL TTS jobs concurrently upfront
            tts_futures = []
            for i, msg in enumerate(ai_messages):
                f = executor.submit(run_tts_for_message, i, msg["text"])
                tts_futures.append(f)
            logger.info("[/tts-stream] Submitted %d TTS jobs concurrently", len(ai_messages))

            # Stream in order: wait for TTS → lip-sync → yield
            # While lip-sync runs for message_i, TTS for message_i+1 is already running
            for i, msg in enumerate(ai_messages):
                t_msg = time.perf_counter()
                tts_futures[i].result()  # Wait for this message's TTS

                try:
                    run_lipsync_and_attach(i, msg)
                except Exception as e:
                    logger.error("[/tts-stream] LipSync error for message %d: %s", i, e)
                    msg["audio"] = ""
                    msg["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

                logger.info("[/tts-stream] Streamed message_%d in %.3fs (time since request: %.3fs)",
                            i, time.perf_counter() - t_msg, time.perf_counter() - request_start)
                yield f"data: {json.dumps(msg)}\n\n"

        total = time.perf_counter() - request_start
        logger.info("[/tts-stream] All messages streamed. Total request time: %.3fs", total)
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/sts", methods=["POST"])
def sts():
    request_start = time.perf_counter()
    logger.info("[/sts] Request received (audio transcription + chat)")
    data = request.get_json()
    base64_audio = data.get("audio", "")
    audio_bytes = base64.b64decode(base64_audio)

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.replace(".webm", ".wav")

    try:
        t_ffmpeg = time.perf_counter()
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in_path, tmp_out_path],
            capture_output=True,
            check=True,
        )
        logger.info("[/sts] ffmpeg webm->wav took %.3fs", time.perf_counter() - t_ffmpeg)

        if gemini_model:
            with open(tmp_out_path, "rb") as audio_file:
                audio_data = audio_file.read()
            t_stt = time.perf_counter()
            response = gemini_model.generate_content(
                [
                    "Transcribe this audio to text. Return ONLY the transcribed text, nothing else.",
                    {"mime_type": "audio/wav", "data": audio_data},
                ]
            )
            stt_elapsed = time.perf_counter() - t_stt
            user_message = response.text.strip()
            logger.info("[/sts] Gemini STT took %.3fs -> '%s'", stt_elapsed, user_message[:80])
        else:
            user_message = ""
    finally:
        if os.path.exists(tmp_in_path):
            os.unlink(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.unlink(tmp_out_path)

    if not user_message:
        return jsonify({"messages": DEFAULT_RESPONSE})

    try:
        t0 = time.perf_counter()
        ai_messages = chat_with_gemini(user_message)
        logger.info("[/sts] Gemini chat took %.3fs", time.perf_counter() - t0)
    except Exception as e:
        logger.error("[/sts] Gemini API error: %s", e)
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = process_lip_sync(ai_messages)

    total = time.perf_counter() - request_start
    logger.info("[/sts] Total request time: %.3fs", total)
    return jsonify({"messages": ai_messages})


@app.route("/sts-stream", methods=["POST"])
def sts_stream():
    """SSE endpoint for speech-to-speech that streams each message.

    Accepts pre-transcribed text from client-side Web Speech API.
    """
    request_start = time.perf_counter()
    data = request.get_json()
    user_message = data.get("text", "")
    logger.info("[/sts-stream] Request received (client-side STT): '%s'", user_message[:80])

    if not user_message:
        return jsonify({"messages": DEFAULT_RESPONSE})

    try:
        t0 = time.perf_counter()
        ai_messages = chat_with_gemini(user_message)
        logger.info("[/sts-stream] Gemini call took %.3fs", time.perf_counter() - t0)
    except Exception as e:
        logger.error("[/sts-stream] Gemini API error: %s", e)
        ai_messages = list(DEFAULT_RESPONSE)

    def generate():
        with ThreadPoolExecutor(max_workers=max(len(ai_messages), 3)) as executor:
            # Start ALL TTS jobs concurrently upfront
            tts_futures = []
            for i, msg in enumerate(ai_messages):
                f = executor.submit(run_tts_for_message, i, msg["text"])
                tts_futures.append(f)
            logger.info("[/sts-stream] Submitted %d TTS jobs concurrently", len(ai_messages))

            # Stream in order: wait for TTS → lip-sync → yield
            for i, msg in enumerate(ai_messages):
                t_msg = time.perf_counter()
                tts_futures[i].result()  # Wait for this message's TTS

                try:
                    run_lipsync_and_attach(i, msg)
                except Exception as e:
                    logger.error("[/sts-stream] LipSync error for message %d: %s", i, e)
                    msg["audio"] = ""
                    msg["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

                logger.info("[/sts-stream] Streamed message_%d in %.3fs (time since request: %.3fs)",
                            i, time.perf_counter() - t_msg, time.perf_counter() - request_start)
                yield f"data: {json.dumps(msg)}\n\n"

        total = time.perf_counter() - request_start
        logger.info("[/sts-stream] All messages streamed. Total request time: %.3fs", total)
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    os.makedirs(AUDIOS_DIR, exist_ok=True)
    os.makedirs(BIN_DIR, exist_ok=True)
    app.run(host="0.0.0.0", port=3000, debug=True)
