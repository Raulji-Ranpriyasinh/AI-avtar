import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadAvatar, updateAvatar, getAvatarGroup } from "./avatar.js";
import { initPoseControls } from "./poseControls.js";
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

      // Initialize pose controls after avatar is loaded
      const group = getAvatarGroup();
      if (group) {
        initPoseControls(group);
      }
    })
    .catch((err) => {
      console.error("Failed to load avatar:", err);
      hideLoader();
    });

  initMicrophone();
  initChatUI();
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

window.addEventListener("DOMContentLoaded", init);
