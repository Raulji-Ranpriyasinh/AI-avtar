import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
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
    if (key === "eyeBlinkLeft" || key === "eyeBlinkRight") return;
    const mapping = facialExpressions[currentFacialExpression];
    if (mapping && mapping[key]) {
      lerpMorphTarget(key, mapping[key], 0.1);
    } else {
      lerpMorphTarget(key, 0, 0.1);
    }
  });

  lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
  lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

  const appliedMorphTargets = [];
  if (currentAudio && currentLipsync) {
    const currentAudioTime = currentAudio.currentTime;
    for (let i = 0; i < currentLipsync.mouthCues.length; i++) {
      const mouthCue = currentLipsync.mouthCues[i];
      if (currentAudioTime >= mouthCue.start && currentAudioTime <= mouthCue.end) {
        const viseme = visemesMapping[mouthCue.value];
        if (viseme) {
          appliedMorphTargets.push(viseme);
          lerpMorphTarget(viseme, 1, 0.2);
        }
        break;
      }
    }
  }

  Object.values(visemesMapping).forEach((value) => {
    if (!appliedMorphTargets.includes(value)) {
      lerpMorphTarget(value, 0, 0.1);
    }
  });
}

function loadAvatar(targetScene) {
  scene = targetScene;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

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
            // Collect valid node names from the avatar skeleton
            const validNodes = new Set();
            avatarGroup.traverse((node) => {
              if (node.name) validNodes.add(node.name);
            });

            // Check skeleton compatibility by counting how many tracks target valid bones
            let totalTracks = 0;
            let matchedTracks = 0;
            animGltf.animations.forEach((clip) => {
              clip.tracks.forEach((track) => {
                totalTracks++;
                const nodeName = THREE.PropertyBinding.parseTrackName(track.name).nodeName;
                if (validNodes.has(nodeName)) matchedTracks++;
              });
            });

            const matchRatio = totalTracks > 0 ? matchedTracks / totalTracks : 0;
            if (matchRatio < 0.5) {
              // Skeleton is incompatible — skip body animations to avoid distortion
              console.warn(
                `animations.glb skeleton incompatible with avatar (${matchedTracks}/${totalTracks} tracks matched). Skipping body animations.`
              );
              startBlinking();
              subscribe(onSpeechUpdate);
              resolve();
              return;
            }

            // Skeleton is compatible enough — filter out unmatched tracks and apply
            mixer = new THREE.AnimationMixer(avatarGroup);
            animGltf.animations.forEach((clip) => {
              clip.tracks = clip.tracks.filter((track) => {
                const nodeName = THREE.PropertyBinding.parseTrackName(track.name).nodeName;
                return validNodes.has(nodeName);
              });
            });

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
          (animError) => {
            console.warn("animations.glb not found, continuing without body animations:", animError);
            startBlinking();
            subscribe(onSpeechUpdate);
            resolve();
          }
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
