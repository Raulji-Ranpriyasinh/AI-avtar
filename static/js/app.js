import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadAvatar, updateAvatar, getDebugState } from "./avatar.js";
import {
  subscribe,
  getState,
  getMessageCount,
  tts,
  startRecording,
  stopRecording,
  initMicrophone,
} from "./speech.js";

let renderer, scene, camera, controls, clock;

function init() {
  const container = document.getElementById("canvas-container");

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    10,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  );
  camera.position.set(0, 2.2, 5);
  camera.lookAt(0, 1.0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.update();

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffeedd, 1.5);
  dirLight.position.set(5, 10, 7.5);
  dirLight.castShadow = true;
  scene.add(dirLight);

  const hemiLight = new THREE.HemisphereLight(0xffeeb1, 0x080820, 0.8);
  scene.add(hemiLight);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const neutralEnv = pmremGenerator.fromScene(
    new THREE.Scene(),
    0,
    0.1,
    100
  ).texture;
  scene.environment = neutralEnv;
  scene.background = null;
  pmremGenerator.dispose();

  clock = new THREE.Clock();

  window.addEventListener("resize", onWindowResize);

  loadAvatar(scene)
    .then((avatarInfo) => {
      if (avatarInfo) {
        const { center, size } = avatarInfo;
        // Frame upper body: target at about 70% of model height
        const targetY = size.y * 0.7;
        controls.target.set(center.x, targetY, center.z);

        // Position camera to frame the upper body
        const fovRad = camera.fov * (Math.PI / 180);
        const frameHeight = size.y * 0.5;
        const distance = frameHeight / (2 * Math.tan(fovRad / 2));
        camera.position.set(center.x, targetY, center.z + distance);
        camera.updateProjectionMatrix();
        controls.update();
      }
      hideLoader();
      animate();
    })
    .catch((err) => {
      console.error("Failed to load avatar:", err);
      hideLoader();
    });

  initMicrophone();
  initChatUI();
  initDebugPanel();
}

function hideLoader() {
  const loader = document.getElementById("loader");
  if (loader) loader.style.display = "none";
}

function onWindowResize() {
  const container = document.getElementById("canvas-container");
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

let debugFrameCount = 0;

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  controls.update();
  updateAvatar(delta);
  renderer.render(scene, camera);

  // Update debug panel every 6 frames (~10 Hz at 60fps) to avoid perf overhead
  debugFrameCount++;
  if (debugFrameCount % 6 === 0) {
    updateDebugPanel();
  }
}

function initChatUI() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const micBtn = document.getElementById("mic-btn");
  const statusText = document.getElementById("status-text");

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (text) {
      tts(text);
      input.value = "";
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (text) {
        tts(text);
        input.value = "";
      }
    }
  });

  let isRecording = false;
  micBtn.addEventListener("click", () => {
    if (isRecording) {
      stopRecording();
      isRecording = false;
      micBtn.classList.remove("recording");
    } else {
      startRecording();
      isRecording = true;
      micBtn.classList.add("recording");
    }
  });

  subscribe(() => {
    const state = getState();
    if (state.loading) {
      statusText.textContent = "Loading...";
      sendBtn.disabled = true;
      sendBtn.classList.add("disabled");
    } else if (state.currentMessage) {
      statusText.textContent = "Speaking...";
      sendBtn.disabled = true;
      sendBtn.classList.add("disabled");
    } else {
      statusText.textContent =
        "Type a message and press enter to chat with the AI.";
      sendBtn.disabled = false;
      sendBtn.classList.remove("disabled");
    }
  });
}

function initDebugPanel() {
  const panel = document.getElementById("debug-panel");
  const toggle = document.getElementById("debug-toggle");
  if (!panel || !toggle) return;

  toggle.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    toggle.textContent = panel.classList.contains("collapsed") ? "+" : "_";
  });
}

function updateDebugPanel() {
  const avatarDebug = getDebugState();
  const speechState = getState();
  const queueLen = getMessageCount();

  const elAnim = document.getElementById("debug-animation");
  const elExpr = document.getElementById("debug-expression");
  const elViseme = document.getElementById("debug-viseme");
  const elAudioTime = document.getElementById("debug-audio-time");
  const elQueue = document.getElementById("debug-queue");
  const elSpeechState = document.getElementById("debug-speech-state");
  const elText = document.getElementById("debug-text");
  const elLog = document.getElementById("debug-log");

  if (!elAnim) return;

  elAnim.textContent = avatarDebug.currentAnimation || "--";
  elExpr.textContent = avatarDebug.currentFacialExpression || "--";
  elViseme.textContent = avatarDebug.activeViseme || "(none)";
  elAudioTime.textContent =
    avatarDebug.audioTime != null
      ? avatarDebug.audioTime.toFixed(3) + "s"
      : "--";
  elQueue.textContent = `${queueLen} message(s)`;

  let stateLabel = "idle";
  if (speechState.loading) stateLabel = "loading";
  else if (speechState.recording) stateLabel = "recording";
  else if (speechState.currentMessage) stateLabel = "speaking";
  elSpeechState.textContent = stateLabel;

  elText.textContent = speechState.currentMessage
    ? speechState.currentMessage.text
    : "--";

  // Render log entries
  const logHtml = avatarDebug.logs
    .slice(0, 30)
    .map((entry) => {
      const cls =
        entry.type === "anim"
          ? "log-anim"
          : entry.type === "expr"
          ? "log-expr"
          : entry.type === "viseme"
          ? "log-viseme"
          : "log-state";
      return `<div class="log-entry"><span class="${cls}">[${entry.ts}] ${entry.type}: ${entry.message}</span></div>`;
    })
    .join("");
  elLog.innerHTML = logHtml;
}

window.addEventListener("DOMContentLoaded", init);
