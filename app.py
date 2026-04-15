import asyncio
import base64
import json
import os
import platform
import random
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from flask import Response

import edge_tts
import google.generativeai as genai
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
CORS(app)

# Logging utility
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
Each message has properties for text and facialExpression.

The different facial expressions are: smile, sad, angry, surprised, and default.

Respond ONLY with valid JSON in this exact format:
{
  "messages": [
    {
      "text": "Your response text here",
      "facialExpression": "smile"
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

# Natural animation configuration
TALKING_ANIMATIONS = ["TalkingOne", "TalkingTwo", "TalkingThree"]
GESTURE_ANIMATIONS = ["DismissingGesture", "ThoughtfulHeadShake"]

def assign_natural_animation(messages, context=None):
    """
    Assign natural animations to messages following these rules:
    - Avoid consecutive same animations
    - Use weighted randomness for variety
    - Create natural conversational flow
    - Use talking animations for most messages
    - Occasionally use gesture animations for emphasis
    - Ensure smooth transitions
    """
    if not messages:
        return messages
    
    # For multi-message responses, create a natural arc
    num_messages = len(messages)
    
    for i, msg in enumerate(messages):
        if num_messages == 1:
            # Single message - just use a random talking animation
            animation = random.choice(TALKING_ANIMATIONS)
        elif i == 0:
            # First message - start with energy
            animation = random.choice(TALKING_ANIMATIONS)
        elif i == num_messages - 1:
            # Last message - wind down, avoid gestures at the end
            animation = random.choice(TALKING_ANIMATIONS)
        else:
            # Middle messages - mix of talking and occasional gestures
            # 75% talking, 25% gesture for variety
            if random.random() < 0.75:
                animation = random.choice(TALKING_ANIMATIONS)
            else:
                animation = random.choice(GESTURE_ANIMATIONS)
        
        msg["animation"] = animation
    
    # Post-process: ensure no consecutive same animations
    for i in range(1, len(messages)):
        if messages[i]["animation"] == messages[i-1]["animation"]:
            # Change to a different animation
            if messages[i]["animation"] in TALKING_ANIMATIONS:
                available = [a for a in TALKING_ANIMATIONS if a != messages[i]["animation"]]
                messages[i]["animation"] = random.choice(available)
            else:
                # Switch to a talking animation
                messages[i]["animation"] = random.choice(TALKING_ANIMATIONS)
    
    log_event("ANIMATION_ASSIGNED", details=f"Assigned animations: {[m.get('animation') for m in messages]}")
    return messages


def audio_file_to_base64(file_path):
    with open(file_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def read_json_transcript(file_path):
    with open(file_path, "r") as f:
        return json.load(f)


def get_default_messages(user_message):
    if not user_message:
        log_event("DEFAULT_INTRO", details="Using default intro messages")
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
                "animation": random.choice(["TalkingTwo", "TalkingThree"]),
            },
        ]

    if not GEMINI_API_KEY:
        log_event("DEFAULT_API_KEY", details="GEMINI_API_KEY not set, using default error message")
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
    start_time = log_event("GEMINI_REQUEST", details=f"User message: {user_message[:50]}...")
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(
        [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": '{"messages": [{"text": "Hello!", "facialExpression": "smile"}]}'}]},
            {"role": "user", "parts": [{"text": user_message}]},
        ]
    )
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
    
    # Assign natural animations to messages
    messages = assign_natural_animation(messages)
    
    log_event("GEMINI_RESPONSE", details=f"Generated {len(messages)} messages", start_time=start_time)
    return messages


async def convert_text_to_speech(text, output_path):
    start_time = log_event("TTS_START", details=f"Text: {text[:50]}...")
    communicate = edge_tts.Communicate(text, EDGE_TTS_VOICE)
    await communicate.save(output_path)
    log_event("TTS_COMPLETE", details=f"Saved to: {output_path}", start_time=start_time)


def generate_lip_sync(message_index):
    start_time = log_event("LIPSYNC_START", details=f"Processing message {message_index}")
    mp3_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.mp3")
    wav_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.wav")
    json_path = os.path.join(AUDIOS_DIR, f"message_{message_index}.json")

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
    
    log_event("LIPSYNC_COMPLETE", details=f"Message {message_index} processed", start_time=start_time)


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
@app.route("/tts_stream", methods=["POST"])
def tts_stream():
    """
    High-performance streaming endpoint that streams messages as soon as they're ready.
    Architecture:
    1. Get Gemini response
    2. For each message:
       - Generate TTS
       - Generate lip-sync (parallel with next message TTS)
       - Stream immediately when ready
    """
    request_start = log_event("REQUEST_RECEIVED", details="tts_stream endpoint called")
    data = request.get_json()
    user_message = data.get("message", "")
    client_timestamp = data.get("clientTimestamp")

    log_msg = f"Message: {user_message}"
    if client_timestamp:
        log_msg += f" | Client sent at: {client_timestamp}"
    log_event("USER_MESSAGE", details=log_msg, start_time=request_start)

    def generate():
        process_start = log_event("PROCESSING_START", details="Starting streaming pipeline")
        
        # Step 1: Get Gemini messages with natural animations
        ai_messages = chat_with_gemini(user_message)
        num_messages = len(ai_messages)
        
        log_event("MESSAGES_READY", details=f"Generated {num_messages} messages to process")
        
        # Step 2: Process and stream each message sequentially
        # This ensures NO audio overlap - message 0 completes before message 1 starts
        for i in range(num_messages):
            msg = ai_messages[i]
            msg_start = log_event(f"MESSAGE_{i}_START", details=f"Processing message {i+1}/{num_messages}")
            
            mp3_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")
            
            # Generate TTS for this message
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(convert_text_to_speech(msg["text"], mp3_path))
            finally:
                loop.close()
            
            # Generate lip-sync for this message
            generate_lip_sync(i)
            
            # Load audio and lipsync data
            msg["audio"] = audio_file_to_base64(mp3_path)
            json_path = os.path.join(AUDIOS_DIR, f"message_{i}.json")
            msg["lipsync"] = read_json_transcript(json_path)
            
            # Add message sequence info for frontend
            msg["messageIndex"] = i
            msg["totalMessages"] = num_messages
            
            # Stream this message immediately
            log_event(f"MESSAGE_{i}_STREAMING", details=f"Streaming message {i+1}/{num_messages}")
            yield f"data: {json.dumps(msg)}\n\n"
            
            log_event(f"MESSAGE_{i}_COMPLETE", details=f"Message {i+1} streamed", start_time=msg_start)
        
        log_event("PROCESSING_COMPLETE", details=f"All {num_messages} messages streamed", start_time=process_start)

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})

@app.route("/tts", methods=["POST"])
def tts():
    request_start = log_event("REQUEST_RECEIVED", details="tts endpoint called")
    data = request.get_json()
    user_message = data.get("message", "")
    log_event("USER_MESSAGE", details=f"Message: {user_message}", start_time=request_start)

    default_msgs = get_default_messages(user_message)
    if default_msgs is not None:
        return jsonify({"messages": default_msgs})

    try:
        ai_messages = chat_with_gemini(user_message)
    except Exception as e:
        print(f"Gemini API error: {e}")
        ai_messages = list(DEFAULT_RESPONSE)

    ai_messages = process_lip_sync(ai_messages)
    log_event("REQUEST_COMPLETE", details="Response sent to client", start_time=request_start)
    return jsonify({"messages": ai_messages})


@app.route("/sts", methods=["POST"])
def sts():
    request_start = log_event("REQUEST_RECEIVED", details="sts endpoint called")
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
            log_event("AUDIO_TRANSCRIBED", details=f"Transcribed: {user_message[:50]}...", start_time=request_start)
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
    log_event("REQUEST_COMPLETE", details="Response sent to client", start_time=request_start)
    return jsonify({"messages": ai_messages})


if __name__ == "__main__":
    os.makedirs(AUDIOS_DIR, exist_ok=True)
    os.makedirs(BIN_DIR, exist_ok=True)
    app.run(host="0.0.0.0", port=3000, debug=True)