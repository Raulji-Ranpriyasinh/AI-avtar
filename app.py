import asyncio
import base64
import json
import os
import platform
import subprocess
import tempfile
import uuid

import edge_tts
import google.generativeai as genai
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
CORS(app)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")

AUDIOS_DIR = os.path.join(os.path.dirname(__file__), "audios")
BIN_DIR = os.path.join(os.path.dirname(__file__), "bin")
if platform.system() == "Windows":
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb.exe")
else:
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb")

SYSTEM_PROMPT = """You are Rey a Medical Health Expert Developed by reyna Solutions.
You will always respond with a JSON array of messages, with a maximum of 3 messages.
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


def _clean_gemini_text(text):
    """Strip markdown fences from Gemini output and parse JSON."""
    text = text.strip()
    if text.startswith("```json"):
        text = text[7:]
    if text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    return text


def chat_with_gemini(user_message):
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(
        [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": '{"messages": [{"text": "Hello!", "facialExpression": "smile", "animation": "TalkingOne"}]}'}]},
            {"role": "user", "parts": [{"text": user_message}]},
        ]
    )
    text = _clean_gemini_text(response.text)
    parsed = json.loads(text)
    return parsed.get("messages", DEFAULT_RESPONSE)


def chat_with_gemini_stream(user_message):
    """Use Gemini streaming for faster time-to-first-byte.

    Collects streamed chunks and returns parsed messages as soon as the
    full JSON is available.
    """
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(
        [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": '{"messages": [{"text": "Hello!", "facialExpression": "smile", "animation": "TalkingOne"}]}'}]},
            {"role": "user", "parts": [{"text": user_message}]},
        ],
        stream=True,
    )
    accumulated = ""
    for chunk in response:
        if chunk.text:
            accumulated += chunk.text
    text = _clean_gemini_text(accumulated)
    parsed = json.loads(text)
    return parsed.get("messages", DEFAULT_RESPONSE)


async def convert_text_to_speech(text, output_path):
    communicate = edge_tts.Communicate(text, EDGE_TTS_VOICE)
    await communicate.save(output_path)


def generate_lip_sync(message_index, uid=""):
    """Convert mp3 to wav via ffmpeg and run Rhubarb lip-sync.

    *uid* is an optional unique prefix so concurrent requests don't
    clobber each other's temp files.
    """
    prefix = f"{uid}_" if uid else ""
    mp3_path = os.path.join(AUDIOS_DIR, f"{prefix}message_{message_index}.mp3")
    wav_path = os.path.join(AUDIOS_DIR, f"{prefix}message_{message_index}.wav")
    json_path = os.path.join(AUDIOS_DIR, f"{prefix}message_{message_index}.json")

    subprocess.run(
        ["ffmpeg", "-y", "-i", mp3_path, wav_path],
        capture_output=True,
        check=True,
    )

    if os.path.isfile(RHUBARB_BIN):
        result = subprocess.run(
            [RHUBARB_BIN, "-f", "json", "-o", json_path, wav_path, "-r", "phonetic"],
            capture_output=True,
        )
        if result.returncode != 0:
            print(f"WARNING: Rhubarb failed with exit code {result.returncode}.")
            if result.stderr:
                print(f"Rhubarb stderr: {result.stderr.decode(errors='replace')}")
            if result.stdout:
                print(f"Rhubarb stdout: {result.stdout.decode(errors='replace')}")
            empty_lipsync = {"metadata": {"duration": 0}, "mouthCues": []}
            with open(json_path, "w") as f:
                json.dump(empty_lipsync, f)
    else:
        print(f"WARNING: Rhubarb binary not found at {RHUBARB_BIN}. Lip sync will be empty. Download from https://github.com/DanielSWolf/rhubarb-lip-sync/releases")
        empty_lipsync = {"metadata": {"duration": 0}, "mouthCues": []}
        with open(json_path, "w") as f:
            json.dump(empty_lipsync, f)


def process_lip_sync(messages):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def generate_all_audio():
        tasks = []
        for i, msg in enumerate(messages):
            output_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
            tasks.append(convert_text_to_speech(msg["text"], output_path))
        await asyncio.gather(*tasks)

    loop.run_until_complete(generate_all_audio())
    loop.close()

    for i, msg in enumerate(messages):
        try:
            generate_lip_sync(i)
            mp3_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
            json_path = os.path.join(AUDIOS_DIR, f"message_{i}.json")
            msg["audio"] = audio_file_to_base64(mp3_path)
            msg["lipsync"] = read_json_transcript(json_path)
        except Exception as e:
            print(f"Error processing lip sync for message {i}: {e}")
            msg["audio"] = ""
            msg["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

    return messages


def _process_single_message(index, msg, uid):
    """TTS + ffmpeg + Rhubarb for a single message.

    Returns the enriched message dict with *audio* (base64) and *lipsync*.
    Uses a unique *uid* prefix so parallel requests don't collide.
    """
    prefix = f"{uid}_" if uid else ""
    mp3_path = os.path.join(AUDIOS_DIR, f"{prefix}message_{index}.mp3")
    json_path = os.path.join(AUDIOS_DIR, f"{prefix}message_{index}.json")

    # 1. TTS
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(convert_text_to_speech(msg["text"], mp3_path))
    finally:
        loop.close()

    # 2. ffmpeg + Rhubarb
    try:
        generate_lip_sync(index, uid=uid)
        msg["audio"] = audio_file_to_base64(mp3_path)
        msg["lipsync"] = read_json_transcript(json_path)
    except Exception as e:
        print(f"Error processing lip sync for message {index}: {e}")
        msg["audio"] = ""
        msg["lipsync"] = {"metadata": {"duration": 0}, "mouthCues": []}

    # 3. Clean up temp files
    for path in [
        mp3_path,
        json_path,
        os.path.join(AUDIOS_DIR, f"{prefix}message_{index}.wav"),
    ]:
        try:
            if os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass

    return msg


def _stream_messages(ai_messages):
    """Generator that yields SSE events for each message as it becomes ready.

    Each message goes through TTS → ffmpeg → Rhubarb individually so the
    frontend can start playback while later messages are still processing.
    """
    uid = uuid.uuid4().hex[:8]
    total = len(ai_messages)

    for i, msg in enumerate(ai_messages):
        enriched = _process_single_message(i, msg, uid)
        event_data = json.dumps({
            "index": i,
            "total": total,
            "message": enriched,
        })
        yield f"data: {event_data}\n\n"

    # Signal stream completion
    yield "data: [DONE]\n\n"


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
    data = request.get_json()
    user_message = data.get("message", "")

    default_msgs = get_default_messages(user_message)
    if default_msgs is not None:
        return jsonify({"messages": default_msgs})

    try:
        ai_messages = chat_with_gemini(user_message)
    except Exception as e:
        print(f"Gemini API error: {e}")
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = process_lip_sync(ai_messages)
    return jsonify({"messages": ai_messages})


@app.route("/tts-stream", methods=["POST"])
def tts_stream():
    """Streaming version of /tts.

    Uses Server-Sent Events to push each message (with audio + lipsync)
    to the frontend as soon as it is ready, so playback can begin while
    later messages are still being processed.
    """
    data = request.get_json()
    user_message = data.get("message", "")

    # Handle default / empty / no-API-key cases as a single SSE burst
    default_msgs = get_default_messages(user_message)
    if default_msgs is not None:
        def _default_gen():
            for i, msg in enumerate(default_msgs):
                event_data = json.dumps({
                    "index": i,
                    "total": len(default_msgs),
                    "message": msg,
                })
                yield f"data: {event_data}\n\n"
            yield "data: [DONE]\n\n"
        return Response(_default_gen(), mimetype="text/event-stream")

    # Use streaming Gemini for faster TTFB
    try:
        ai_messages = chat_with_gemini_stream(user_message)
    except Exception as e:
        print(f"Gemini API error: {e}")
        ai_messages = list(DEFAULT_RESPONSE)

    return Response(
        _stream_messages(ai_messages),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/sts", methods=["POST"])
def sts():
    data = request.get_json()
    base64_audio = data.get("audio", "")
    audio_bytes = base64.b64decode(base64_audio)

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.replace(".webm", ".wav")

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in_path, tmp_out_path],
            capture_output=True,
            check=True,
        )

        if GEMINI_API_KEY:
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel("gemini-2.5-flash")
            with open(tmp_out_path, "rb") as audio_file:
                audio_data = audio_file.read()
            response = model.generate_content(
                [
                    "Transcribe this audio to text. Return ONLY the transcribed text, nothing else.",
                    {"mime_type": "audio/wav", "data": audio_data},
                ]
            )
            user_message = response.text.strip()
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
        ai_messages = chat_with_gemini(user_message)
    except Exception as e:
        print(f"Gemini API error: {e}")
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = process_lip_sync(ai_messages)
    return jsonify({"messages": ai_messages})


@app.route("/sts-stream", methods=["POST"])
def sts_stream():
    """Streaming version of /sts.

    Transcribes the uploaded audio via Gemini, then streams back each
    AI response message with audio + lipsync via SSE.
    """
    data = request.get_json()
    base64_audio = data.get("audio", "")
    audio_bytes = base64.b64decode(base64_audio)

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.replace(".webm", ".wav")

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in_path, tmp_out_path],
            capture_output=True,
            check=True,
        )

        if GEMINI_API_KEY:
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel("gemini-2.5-flash")
            with open(tmp_out_path, "rb") as audio_file:
                audio_data = audio_file.read()
            response = model.generate_content(
                [
                    "Transcribe this audio to text. Return ONLY the transcribed text, nothing else.",
                    {"mime_type": "audio/wav", "data": audio_data},
                ]
            )
            user_message = response.text.strip()
        else:
            user_message = ""
    finally:
        if os.path.exists(tmp_in_path):
            os.unlink(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.unlink(tmp_out_path)

    if not user_message:
        def _empty_gen():
            for i, msg in enumerate(DEFAULT_RESPONSE):
                event_data = json.dumps({
                    "index": i,
                    "total": len(DEFAULT_RESPONSE),
                    "message": msg,
                })
                yield f"data: {event_data}\n\n"
            yield "data: [DONE]\n\n"
        return Response(_empty_gen(), mimetype="text/event-stream")

    try:
        ai_messages = chat_with_gemini_stream(user_message)
    except Exception as e:
        print(f"Gemini API error: {e}")
        ai_messages = list(DEFAULT_RESPONSE)

    return Response(
        _stream_messages(ai_messages),
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
