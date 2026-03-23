import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { facialExpressions, visemesMapping, morphTargets } from "./constants.js";
import { getState, onMessagePlayed, subscribe } from "./speech.js";

let scene = null;
let avatarGroup = null;
let mixer = null;
let actions = {};
let currentAnimation = "Idle";
let currentFacialExpression = "";
let currentLipsync = null;
let currentAudio = null;
let blink = false;
let blinkTimeout = null;
let avatarScene = null;

function lerpMorphTarget(target, value, speed) {
  if (!avatarScene) return;
  avatarScene.traverse((child) => {
    if (child.isSkinnedMesh && child.morphTargetDictionary) {
      const index = child.morphTargetDictionary[target];
      if (index === undefined || child.morphTargetInfluences[index] === undefined) {
        return;
      }
      child.morphTargetInfluences[index] = THREE.MathUtils.lerp(
        child.morphTargetInfluences[index],
        value,
        speed
      );
    }
  });
}

function setAnimation(name) {
  if (currentAnimation === name) return;
  const prevAction = actions[currentAnimation];
  const nextAction = actions[name];
  if (nextAction) {
    nextAction.reset().fadeIn(prevAction ? 0.5 : 0).play();
    if (prevAction) {
      prevAction.fadeOut(0.5);
    }
    currentAnimation = name;
  }
}

function startBlinking() {
  const nextBlink = () => {
    blinkTimeout = setTimeout(() => {
      blink = true;
      setTimeout(() => {
        blink = false;
        nextBlink();
      }, 200);
    }, THREE.MathUtils.randInt(1000, 5000));
  };
  nextBlink();
}

function onSpeechUpdate() {
  const state = getState();
  const message = state.currentMessage;
  if (!message) {
    setAnimation("Idle");
    currentLipsync = null;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    return;
  }
  setAnimation(message.animation || "Idle");
  currentFacialExpression = message.facialExpression || "default";
  currentLipsync = message.lipsync || null;

  if (message.audio) {
    const audio = new Audio("data:audio/mp3;base64," + message.audio);
    audio.play();
    currentAudio = audio;
    audio.onended = () => {
      currentAudio = null;
      onMessagePlayed();
    };
  } else {
    setTimeout(() => onMessagePlayed(), 2000);
  }
}

function updateFrame() {
  morphTargets.forEach((key) => {
    if (key === "h_expressions.LeyeClose_h" || key === "h_expressions.ReyeClose_h") return;
    const mapping = facialExpressions[currentFacialExpression];
    if (mapping && mapping[key]) {
      lerpMorphTarget(key, mapping[key], 0.1);
    } else {
      lerpMorphTarget(key, 0, 0.1);
    }
  });

  lerpMorphTarget("h_expressions.LeyeClose_h", blink ? 1 : 0, 0.5);
  lerpMorphTarget("h_expressions.ReyeClose_h", blink ? 1 : 0, 0.5);

  const appliedMorphTargets = [];
  if (currentAudio && currentLipsync) {
    const currentAudioTime = currentAudio.currentTime;
    for (let i = 0; i < currentLipsync.mouthCues.length; i++) {
      const mouthCue = currentLipsync.mouthCues[i];
      if (currentAudioTime >= mouthCue.start && currentAudioTime <= mouthCue.end) {
        const visemeTargets = visemesMapping[mouthCue.value];
        if (visemeTargets) {
          visemeTargets.forEach((target) => {
            appliedMorphTargets.push(target);
            lerpMorphTarget(target, 1, 0.2);
          });
        }
        break;
      }
    }
  }

  // Reset all viseme morph targets that are not currently active
  const allVisemeTargets = Object.values(visemesMapping).flat();
  allVisemeTargets.forEach((target) => {
    if (!appliedMorphTargets.includes(target)) {
      lerpMorphTarget(target, 0, 0.1);
    }
  });
}

function loadAvatar(targetScene) {
  scene = targetScene;
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      "/static/models/avatar.glb",
      (avatarGltf) => {
        avatarScene = avatarGltf.scene;
        avatarGroup = new THREE.Group();
        avatarGroup.position.set(0, -0.5, 0);
        avatarGroup.add(avatarScene);
        scene.add(avatarGroup);

        loader.load(
          "/static/models/animations.glb",
          (animGltf) => {
            mixer = new THREE.AnimationMixer(avatarGroup);
            animGltf.animations.forEach((clip) => {
              actions[clip.name] = mixer.clipAction(clip);
            });

            if (actions["Idle"]) {
              actions["Idle"].reset().fadeIn(0).play();
              currentAnimation = "Idle";
            } else if (animGltf.animations.length > 0) {
              const firstName = animGltf.animations[0].name;
              actions[firstName].reset().fadeIn(0).play();
              currentAnimation = firstName;
            }

            startBlinking();
            subscribe(onSpeechUpdate);
            resolve();
          },
          undefined,
          reject
        );
      },
      undefined,
      reject
    );
  });
}

function updateAvatar(delta) {
  if (mixer) mixer.update(delta);
  updateFrame();
}

export { loadAvatar, updateAvatar };
