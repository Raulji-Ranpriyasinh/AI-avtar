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
  
import edge_tts  
import google.generativeai as genai  
from dotenv import load_dotenv  
from flask import Flask, Response, jsonify, render_template, request  
from flask_cors import CORS  
  
load_dotenv()  
  
app = Flask(__name__)  
CORS(app)  
  
  
# ---------------------------------------------------------------------------  
# Logging utility  
# ---------------------------------------------------------------------------  
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
  
  
# ---------------------------------------------------------------------------  
# Configuration  
# ---------------------------------------------------------------------------  
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")  
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")  
  
AUDIOS_DIR = os.path.join(os.path.dirname(__file__), "audios")  
BIN_DIR = os.path.join(os.path.dirname(__file__), "bin")  
if platform.system() == "Windows":  
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb.exe")  
else:  
    RHUBARB_BIN = os.path.join(BIN_DIR, "rhubarb")  
  
# Animation is handled server-side — removed from Gemini prompt  
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
  
  
# ---------------------------------------------------------------------------  
# Natural animation configuration (server-side)  
# ---------------------------------------------------------------------------  
TALKING_ANIMATIONS = ["TalkingOne", "TalkingTwo", "TalkingThree"]  
GESTURE_ANIMATIONS = ["DismissingGesture", "ThoughtfulHeadShake"]  
  
  
def assign_natural_animation(messages):  
    """  
    Assign natural animations to messages:  
    - Avoid consecutive same animations  
    - 75% talking / 25% gesture for middle messages  
    - First and last messages always use talking animations  
    """  
    if not messages:  
        return messages  
  
    num_messages = len(messages)  
  
    for i, msg in enumerate(messages):  
        if num_messages == 1:  
            animation = random.choice(TALKING_ANIMATIONS)  
        elif i == 0:  
            animation = random.choice(TALKING_ANIMATIONS)  
        elif i == num_messages - 1:  
            animation = random.choice(TALKING_ANIMATIONS)  
        else:  
            if random.random() < 0.75:  
                animation = random.choice(TALKING_ANIMATIONS)  
            else:  
                animation = random.choice(GESTURE_ANIMATIONS)  
  
        msg["animation"] = animation  
  
    # Post-process: no consecutive duplicates  
    for i in range(1, len(messages)):  
        if messages[i]["animation"] == messages[i - 1]["animation"]:  
            if messages[i]["animation"] in TALKING_ANIMATIONS:  
                available = [a for a in TALKING_ANIMATIONS if a != messages[i]["animation"]]  
                messages[i]["animation"] = random.choice(available)  
            else:  
                messages[i]["animation"] = random.choice(TALKING_ANIMATIONS)  
  
    log_event(  
        "ANIMATION_ASSIGNED",  
        details=f"Assigned animations: {[m.get('animation') for m in messages]}",  
    )  
    return messages  
  
  
# ---------------------------------------------------------------------------  
# Helpers  
# ---------------------------------------------------------------------------  
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
        log_event("DEFAULT_API_KEY", details="GEMINI_API_KEY not set")  
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
  
  
# ---------------------------------------------------------------------------  
# Gemini  
# ---------------------------------------------------------------------------  
def chat_with_gemini(user_message):  
    start_time = log_event("GEMINI_REQUEST", details=f"User message: {user_message[:50]}...")  
    genai.configure(api_key=GEMINI_API_KEY)  
    model = genai.GenerativeModel("gemini-2.5-flash")  
    response = model.generate_content(  
        [  
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},  
            {  
                "role": "model",  
                "parts": [  
                    {"text": '{"messages": [{"text": "Hello!", "facialExpression": "smile"}]}'}  
                ],  
            },  
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
  
    # Assign animations server-side  
    messages = assign_natural_animation(messages)  
  
    log_event(  
        "GEMINI_RESPONSE",  
        details=f"Generated {len(messages)} messages",  
        start_time=start_time,  
    )  
    return messages  
  
  
# ---------------------------------------------------------------------------  
# TTS + Lip-sync  
# ---------------------------------------------------------------------------  
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
        print(  
            f"WARNING: Rhubarb binary not found at {RHUBARB_BIN}. "  
            "Lip sync will be empty. "  
            "Download from https://github.com/DanielSWolf/rhubarb-lip-sync/releases"  
        )  
        empty_lipsync = {"metadata": {"duration": 0}, "mouthCues": []}  
        with open(json_path, "w") as f:  
            json.dump(empty_lipsync, f)  
  
    log_event("LIPSYNC_COMPLETE", details=f"Message {message_index} processed", start_time=start_time)  
  
  
def process_lip_sync(messages):  
    """Batch TTS + lip-sync used by the legacy /tts and /sts endpoints."""  
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
  
  
# ---------------------------------------------------------------------------  
# Routes  
# ---------------------------------------------------------------------------  
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
  
  
# ---------------------------------------------------------------------------  
# /tts_stream — TRUE streaming SSE endpoint (primary)  
#  
# FIXES APPLIED from uncommented version:  
#   1. Single shared asyncio event loop (not create/destroy per message)  
#   2. ThreadPoolExecutor runs lip-sync in a worker thread  
#   3. Stream-end signal {"type":"done"} sent to frontend  
# ---------------------------------------------------------------------------  
@app.route("/tts_stream", methods=["POST"])  
def tts_stream():  
    """  
    High-performance streaming endpoint.  
    1. Get Gemini response (animations assigned server-side)  
    2. ONE shared asyncio loop for all TTS calls  
    3. ThreadPoolExecutor runs lip-sync per message  
    4. Each message is yielded via SSE as soon as it is ready  
    5. A final {"type":"done"} event signals end of stream  
    """  
    request_start = log_event("REQUEST_RECEIVED", details="tts_stream endpoint called")  
    data = request.get_json()  
    user_message = data.get("message", "")  
    client_timestamp = data.get("clientTimestamp")  
  
    log_msg = f"Message: {user_message}"  
    if client_timestamp:  
        log_msg += f" | Client sent at: {client_timestamp}"  
    log_event("USER_MESSAGE", details=log_msg, start_time=request_start)  
  
    # Handle default / missing-key cases as SSE too  
    default_msgs = get_default_messages(user_message)  
    if default_msgs is not None:  
        def generate_defaults():  
            for i, msg in enumerate(default_msgs):  
                msg["messageIndex"] = i  
                msg["totalMessages"] = len(default_msgs)  
                yield f"data: {json.dumps(msg)}\n\n"  
            yield 'data: {"type":"done"}\n\n'  
  
        return Response(  
            generate_defaults(),  
            mimetype="text/event-stream",  
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},  
        )  
  
    def generate():  
        process_start = log_event("PROCESSING_START", details="Starting streaming pipeline")  
  
        # Step 1 — Gemini (animations assigned server-side)  
        try:  
            ai_messages = chat_with_gemini(user_message)  
        except Exception as e:  
            print(f"Gemini API error: {e}")  
            ai_messages = list(DEFAULT_RESPONSE)  
  
        num_messages = len(ai_messages)  
        log_event("MESSAGES_READY", details=f"Generated {num_messages} messages to process")  
  
        # Step 2 — ONE shared event loop + thread pool  
        # FIX 1: single loop instead of create/destroy per message  
        # FIX 2: ThreadPoolExecutor actually used for lip-sync  
        loop = asyncio.new_event_loop()  
        asyncio.set_event_loop(loop)  
        executor = ThreadPoolExecutor(max_workers=2)  
  
        try:  
            for i in range(num_messages):  
                msg = ai_messages[i]  
                msg_start = log_event(  
                    f"MESSAGE_{i}_START",  
                    details=f"Processing message {i + 1}/{num_messages}",  
                )  
  
                mp3_path = os.path.join(AUDIOS_DIR, f"message_{i}.mp3")  
  
                # Generate TTS (async, on the shared loop)  
                loop.run_until_complete(convert_text_to_speech(msg["text"], mp3_path))  
  
                # Run lip-sync in thread pool worker  
                future = executor.submit(generate_lip_sync, i)  
                future.result()  # wait for it to finish before yielding  
  
                # Load audio + lipsync data  
                msg["audio"] = audio_file_to_base64(mp3_path)  
                json_path = os.path.join(AUDIOS_DIR, f"message_{i}.json")  
                msg["lipsync"] = read_json_transcript(json_path)  
                msg["messageIndex"] = i  
                msg["totalMessages"] = num_messages  
  
                # Stream this message immediately  
                log_event(  
                    f"MESSAGE_{i}_STREAMING",  
                    details=f"Streaming message {i + 1}/{num_messages}",  
                )  
                yield f"data: {json.dumps(msg)}\n\n"  
  
                log_event(  
                    f"MESSAGE_{i}_COMPLETE",  
                    details=f"Message {i + 1} streamed",  
                    start_time=msg_start,  
                )  
  
            # FIX 3: Signal end of stream  
            yield 'data: {"type":"done"}\n\n'  
  
            log_event(  
                "PROCESSING_COMPLETE",  
                details=f"All {num_messages} messages streamed",  
                start_time=process_start,  
            )  
        finally:  
            executor.shutdown(wait=True)  
            loop.close()  
  
    return Response(  
        generate(),  
        mimetype="text/event-stream",  
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},  
    )  
  
  
# ---------------------------------------------------------------------------  
# /tts — Legacy batch endpoint (kept as fallback)  
# ---------------------------------------------------------------------------  
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
  
  
# ---------------------------------------------------------------------------  
# /sts — Speech-to-speech endpoint  
# ---------------------------------------------------------------------------  
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
            log_event(  
                "AUDIO_TRANSCRIBED",  
                details=f"Transcribed: {user_message[:50]}...",  
                start_time=request_start,  
            )  
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
  
  
# ---------------------------------------------------------------------------  
# Main  
# ---------------------------------------------------------------------------  
if __name__ == "__main__":  
    os.makedirs(AUDIOS_DIR, exist_ok=True)  
    os.makedirs(BIN_DIR, exist_ok=True)  
    app.run(host="0.0.0.0", port=3000, debug=True)