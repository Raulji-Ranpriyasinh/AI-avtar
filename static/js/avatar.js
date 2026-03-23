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
let morphNameMap = {};

function buildMorphNameMap() {
  if (!avatarScene) return;

  const availableTargets = new Set();
  avatarScene.traverse((child) => {
    if (child.isSkinnedMesh && child.morphTargetDictionary) {
      Object.keys(child.morphTargetDictionary).forEach((name) =>
        availableTargets.add(name)
      );
    }
  });

  if (availableTargets.size === 0) return;

  // If the model already uses standard ARKit names, no mapping needed
  if (availableTargets.has("eyeBlinkLeft") || availableTargets.has("viseme_PP")) {
    return;
  }

  // Map from standard ARKit names to VALID-style morph target names
  const mappingRules = {
    eyeBlinkLeft: ["LeyeClose"],
    eyeBlinkRight: ["ReyeClose"],
    eyeSquintLeft: ["Lsquint"],
    eyeSquintRight: ["Rsquint"],
    eyeWideLeft: ["LeyeOpen"],
    eyeWideRight: ["ReyeOpen"],
    eyeLookDownLeft: ["LlowLid"],
    eyeLookDownRight: ["RlowLid"],
    browDownLeft: ["LbrowDown"],
    browDownRight: ["RbrowDown"],
    browInnerUp: ["RbrowUp"],
    browOuterUpLeft: ["LLbrowUp"],
    browOuterUpRight: ["RRbrowUp"],
    jawOpen: ["MouthOpen"],
    mouthOpen: ["MouthOpen"],
    mouthSmileLeft: ["LsmileOpen"],
    mouthSmileRight: ["RsmileOpen"],
    mouthFrownLeft: ["LmouthSad"],
    mouthFrownRight: ["RmouthSad"],
    mouthPucker: ["Kiss"],
    noseSneerLeft: ["Lnostril"],
    noseSneerRight: ["Rnostril"],
    cheekPuff: ["Rblow"],
    mouthClose: ["JawCompress"],
    jawForward: ["JawFront"],
    jawLeft: ["Ljaw"],
    jawRight: ["Rjaw"],
    mouthShrugLower: ["Chin"],
    tongueOut: ["OutMiddle_tg"],
    viseme_aa: ["AE_AA"],
    viseme_O: ["AO_a"],
    viseme_E: ["Ax_E"],
    viseme_I: ["TD_I"],
    viseme_U: ["UW_U"],
    viseme_FF: ["FV"],
    viseme_SS: [".S_h"],
    viseme_CH: ["SH_CH"],
    viseme_PP: ["MPB_Up"],
    viseme_kk: ["KG"],
    viseme_TH: ["H_EST"],
    viseme_DD: ["TD_I"],
  };

  for (const [expected, keywords] of Object.entries(mappingRules)) {
    if (morphNameMap[expected]) continue;
    for (const keyword of keywords) {
      for (const actual of availableTargets) {
        if (actual.includes(keyword)) {
          morphNameMap[expected] = actual;
          break;
        }
      }
      if (morphNameMap[expected]) break;
    }
  }

  if (Object.keys(morphNameMap).length > 0) {
    console.log("Morph target name mapping applied:", morphNameMap);
  }
}

function lerpMorphTarget(target, value, speed) {
  if (!avatarScene) return;
  const actualTarget = morphNameMap[target] || target;
  avatarScene.traverse((child) => {
    if (child.isSkinnedMesh && child.morphTargetDictionary) {
      const index = child.morphTargetDictionary[actualTarget];
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
        avatarGroup.add(avatarScene);
        scene.add(avatarGroup);

        // Compute bounding box and position model so feet are at y=0
        avatarGroup.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(avatarGroup);
        avatarGroup.position.y = -box.min.y;

        // Recompute bounding box after repositioning
        avatarGroup.updateMatrixWorld(true);
        const finalBox = new THREE.Box3().setFromObject(avatarGroup);
        const avatarBounds = {
          center: finalBox.getCenter(new THREE.Vector3()),
          size: finalBox.getSize(new THREE.Vector3()),
        };

        // Build morph target name mapping for non-standard models
        buildMorphNameMap();

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
              resolve(avatarBounds);
              return;
            }

            // Additional check: verify skeleton transforms are compatible
            // Compares bone scale and position magnitude to detect rig mismatches
            // (e.g. Daz rigs use cm scale 0.01 vs Mixamo rigs at scale 1.0)
            let transformsCompatible = true;
            const animRoot = animGltf.scene;
            animRoot.updateMatrixWorld(true);
            const checkBones = ["Hips", "Spine", "Head"];
            for (const boneName of checkBones) {
              const avatarBone = avatarGroup.getObjectByName(boneName);
              const animBone = animRoot.getObjectByName(boneName);
              if (avatarBone && animBone) {
                // Check scale compatibility
                const sRatio = avatarBone.scale.x / (animBone.scale.x || 1);
                if (sRatio > 5 || sRatio < 0.2) {
                  transformsCompatible = false;
                  console.warn(
                    `Bone "${boneName}" scale mismatch: avatar=${avatarBone.scale.x.toFixed(4)}, anim=${animBone.scale.x.toFixed(4)}`
                  );
                  break;
                }
                // Check position magnitude compatibility
                const avatarPosMag = avatarBone.position.length();
                const animPosMag = animBone.position.length();
                if (avatarPosMag > 0.01 && animPosMag > 0.01) {
                  const pRatio = avatarPosMag / animPosMag;
                  if (pRatio > 10 || pRatio < 0.1) {
                    transformsCompatible = false;
                    console.warn(
                      `Bone "${boneName}" position magnitude mismatch: avatar=${avatarPosMag.toFixed(4)}, anim=${animPosMag.toFixed(4)}`
                    );
                    break;
                  }
                }
              }
            }

            if (!transformsCompatible) {
              console.warn(
                "Animation skeleton transforms are incompatible with avatar. Skipping body animations to avoid distortion."
              );
              startBlinking();
              subscribe(onSpeechUpdate);
              resolve(avatarBounds);
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
            resolve(avatarBounds);
          },
          undefined,
          (animError) => {
            console.warn("animations.glb not found, continuing without body animations:", animError);
            startBlinking();
            subscribe(onSpeechUpdate);
            resolve(avatarBounds);
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
