import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  loadAvatar,
  updateAvatar,
  applyPoseDeltas,
  rebuildIdleWithDeltas,
  DEFAULT_POSE_DELTAS,
  POSE_BONE_SEARCH,
} from "./avatar.js";
import {
  subscribe,
  getState,
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
  initPosePanel();
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

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  controls.update();
  updateAvatar(delta);
  renderer.render(scene, camera);
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
      // Show granular SSE status when available
      if (state.sseStatus === "thinking") {
        statusText.textContent = "Thinking...";
      } else if (state.sseStatus === "generating_audio") {
        statusText.textContent = "Generating audio...";
      } else {
        statusText.textContent = "Loading...";
      }
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

// ---- Pose Control Panel ----

function initPosePanel() {
  const header = document.getElementById("pose-panel-header");
  const body = document.getElementById("pose-panel-body");
  const toggle = document.getElementById("pose-panel-toggle");
  const copyBtn = document.getElementById("pose-copy-btn");
  const resetBtn = document.getElementById("pose-reset-btn");
  const output = document.getElementById("pose-output");
  const slidersContainer = document.getElementById("pose-sliders");

  if (!header || !body) return;

  // Toggle collapse
  header.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    toggle.innerHTML = body.classList.contains("collapsed") ? "&#9654;" : "&#9660;";
  });

  // Current delta values (cloned from defaults)
  const currentDeltas = {};
  for (const [key, val] of Object.entries(DEFAULT_POSE_DELTAS)) {
    currentDeltas[key] = { x: val.x, y: val.y, z: val.z };
  }
  const MIRROR_FLIP = { x: false, y: true, z: true };
const MIRROR_MAP = {};
for (const key of Object.keys(DEFAULT_POSE_DELTAS)) {
  if (key.startsWith('left')) {
    const rKey = 'right' + key.slice(4);
    if (DEFAULT_POSE_DELTAS[rKey] !== undefined) MIRROR_MAP[key] = rKey;
  }
}
let mirrorOn = true;
const mirrorBtn = document.getElementById('pose-mirror-btn');
mirrorBtn.addEventListener('click', () => {
  mirrorOn = !mirrorOn;
  mirrorBtn.textContent = mirrorOn ? '⬡ X Mirror: ON' : '⬡ X Mirror: OFF';
  mirrorBtn.style.background = mirrorOn ? '#4a9eff' : '#555';
});
  // Friendly labels for bone keys
  const boneLabels = {
    leftShoulder: "Left Shoulder",
    rightShoulder: "Right Shoulder",
    leftUpperArm: "Left Upper Arm",
    rightUpperArm: "Right Upper Arm",
    leftElbow: "Left Elbow / Forearm",
    rightElbow: "Right Elbow / Forearm",
    leftHand: "Left Hand",
    rightHand: "Right Hand",
  };

  const axes = ["x", "y", "z"];
  const sliderRefs = {}; // key -> { x: {slider, valSpan}, y: ..., z: ... }

  // Build slider UI for each bone
  for (const key of Object.keys(DEFAULT_POSE_DELTAS)) {
    const group = document.createElement("div");
    group.className = "pose-bone-group";

    const label = document.createElement("div");
    label.className = "pose-bone-label";
    label.textContent = boneLabels[key] || key;
    group.appendChild(label);

    sliderRefs[key] = {};

    for (const axis of axes) {
      const row = document.createElement("div");
      row.className = "pose-slider-row";

      const axisLabel = document.createElement("label");
      axisLabel.textContent = axis.toUpperCase();
      row.appendChild(axisLabel);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "-3.14";
      slider.max = "3.14";
      slider.step = "0.01";
      slider.value = currentDeltas[key][axis];
      row.appendChild(slider);

      const valSpan = document.createElement("span");
      valSpan.className = "pose-val";
      valSpan.textContent = Number(currentDeltas[key][axis]).toFixed(2);
      row.appendChild(valSpan);

      sliderRefs[key][axis] = { slider, valSpan };

      slider.addEventListener("input", () => {
  const v = parseFloat(slider.value);
  currentDeltas[key][axis] = v;
  valSpan.textContent = v.toFixed(2);

  // Mirror logic
  if (mirrorOn) {
    const mirrorKey = MIRROR_MAP[key] ||
      (key.startsWith('right') ? 'left' + key.slice(5) : null);
    if (mirrorKey && sliderRefs[mirrorKey]) {
      const mirroredVal = MIRROR_FLIP[axis] ? -v : v;
      currentDeltas[mirrorKey][axis] = mirroredVal;
      sliderRefs[mirrorKey][axis].slider.value = mirroredVal;
      sliderRefs[mirrorKey][axis].valSpan.textContent = mirroredVal.toFixed(2);
    }
  }

  applyPoseDeltas(currentDeltas);
});

      // On mouse up, rebuild the idle clip so it persists
     slider.addEventListener("change", () => {
  if (mirrorOn) {
    const mirrorKey = MIRROR_MAP[key] ||
      (key.startsWith('right') ? 'left' + key.slice(5) : null);
    if (mirrorKey) rebuildIdleWithDeltas(currentDeltas);
    else rebuildIdleWithDeltas(currentDeltas);
  } else {
    rebuildIdleWithDeltas(currentDeltas);
  }
});

      group.appendChild(row);
    }

    slidersContainer.appendChild(group);
  }

  // Copy values button
  copyBtn.addEventListener("click", () => {
    const lines = [];
    for (const [key, d] of Object.entries(currentDeltas)) {
      lines.push(`${key}: { x: ${d.x.toFixed(2)}, y: ${d.y.toFixed(2)}, z: ${d.z.toFixed(2)} }`);
    }
    const text = lines.join("\n");
    output.value = text;
    navigator.clipboard.writeText(text).catch(() => {});
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy Values"; }, 1500);
  });

  // Reset button
  resetBtn.addEventListener("click", () => {
    for (const [key, val] of Object.entries(DEFAULT_POSE_DELTAS)) {
      currentDeltas[key] = { x: val.x, y: val.y, z: val.z };
      for (const axis of axes) {
        const ref = sliderRefs[key][axis];
        ref.slider.value = val[axis];
        ref.valSpan.textContent = val[axis].toFixed(2);
      }
    }
    rebuildIdleWithDeltas(currentDeltas);
    output.value = "";
  });
}

window.addEventListener("DOMContentLoaded", init);
