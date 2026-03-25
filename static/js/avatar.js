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
let lastTalkingAnims = [];
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
  // Each value is an array of keywords to search for in the model's morph target names.
  // If the value is an array of arrays, ALL matching targets are driven together (multi-target).
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

  // Multi-target mappings: one ARKit name drives multiple VALID targets simultaneously
  const multiMappingRules = {
    browInnerUp: [["RbrowUp"], ["LbrowUp"]],
    cheekPuff: [["Rblow"], ["Lblow"]],
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

  // Process multi-target mappings
  for (const [expected, keywordSets] of Object.entries(multiMappingRules)) {
    const matches = [];
    for (const keywords of keywordSets) {
      for (const keyword of keywords) {
        for (const actual of availableTargets) {
          if (actual.includes(keyword)) {
            matches.push(actual);
            break;
          }
        }
      }
    }
    if (matches.length > 0) {
      morphNameMap[expected] = matches;
    }
  }

  if (Object.keys(morphNameMap).length > 0) {
    console.log("Morph target name mapping applied:", morphNameMap);
  }
}

function lerpMorphTarget(target, value, speed) {
  if (!avatarScene) return;
  const mapped = morphNameMap[target];
  const targets = mapped
    ? Array.isArray(mapped) ? mapped : [mapped]
    : [target];
  avatarScene.traverse((child) => {
    if (child.isSkinnedMesh && child.morphTargetDictionary) {
      for (const t of targets) {
        const index = child.morphTargetDictionary[t];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) {
          continue;
        }
        child.morphTargetInfluences[index] = THREE.MathUtils.lerp(
          child.morphTargetInfluences[index],
          value,
          speed
        );
      }
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

// Animation groups for intelligent cycling
const TALKING_ANIMS = ["TalkingOne", "TalkingTwo", "TalkingThree"];
const IDLE_ANIMS = ["Idle", "HappyIdle"];

function pickTalkingAnimation(hint) {
  // Build list of available talking animations from loaded actions
  const available = TALKING_ANIMS.filter((name) => actions[name]);
  if (available.length === 0) {
    // Fallback: try the hint or any loaded action that isn't pure Idle
    if (hint && actions[hint]) return hint;
    return "Idle";
  }

  // Filter out the most recently used ones to avoid repeats
  let candidates = available.filter((a) => !lastTalkingAnims.includes(a));
  if (candidates.length === 0) {
    candidates = available;
    lastTalkingAnims = [];
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  lastTalkingAnims.push(pick);
  // Keep history short so older animations become available again
  if (lastTalkingAnims.length > Math.max(1, available.length - 1)) {
    lastTalkingAnims.shift();
  }
  return pick;
}

function pickIdleAnimation() {
  const available = IDLE_ANIMS.filter((name) => actions[name]);
  if (available.length === 0) return "Idle";
  return available[Math.floor(Math.random() * available.length)];
}

function onSpeechUpdate() {
  const state = getState();
  const message = state.currentMessage;
  if (!message) {
    setAnimation(pickIdleAnimation());
    currentLipsync = null;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    return;
  }

  // Choose animation based on the AI's hint but with variety
  const hint = message.animation || "Idle";
  const isTalkingHint = TALKING_ANIMS.includes(hint) || hint.startsWith("Talking");
  const chosenAnim = isTalkingHint ? pickTalkingAnimation(hint) : (actions[hint] ? hint : pickTalkingAnimation(hint));
  setAnimation(chosenAnim);

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

function retargetAnimations(animGltf, avatarGroup) {
  const animRoot = animGltf.scene;
  animRoot.updateMatrixWorld(true);
  avatarGroup.updateMatrixWorld(true);

  // Build bone name mapping (animation bone name → avatar bone name)
  // for bones with slightly different names between rigs
  const avatarNodeNames = new Set();
  avatarGroup.traverse((node) => {
    if (node.name) avatarNodeNames.add(node.name);
  });

  const animNodeNames = new Set();
  animRoot.traverse((node) => {
    if (node.name) animNodeNames.add(node.name);
  });

  const boneNameMap = {};
  for (const animName of animNodeNames) {
    if (avatarNodeNames.has(animName)) continue;
    // Try common naming variations between Daz and Mixamo rigs
    const variations = [
      animName.replace(/_End/g, "End"),
      animName.replace(/Top_End/g, "End"),
    ];
    for (const v of variations) {
      if (avatarNodeNames.has(v)) {
        boneNameMap[animName] = v;
        break;
      }
    }
  }

  // Collect rest transforms from both skeletons
  const avatarRest = {};
  avatarGroup.traverse((node) => {
    if (node.name) {
      avatarRest[node.name] = {
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
      };
    }
  });

  const animRest = {};
  animRoot.traverse((node) => {
    if (node.name) {
      animRest[node.name] = {
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
      };
    }
  });

  // Retarget each animation clip
  animGltf.animations.forEach((clip) => {
    const newTracks = [];

    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const animBoneName = parsed.nodeName;
      const avatarBoneName = boneNameMap[animBoneName] || animBoneName;

      const aRest = avatarRest[avatarBoneName];
      const mRest = animRest[animBoneName];
      if (!aRest || !mRest) continue;

      // Skip retargeting for finger and hand detail bones — their rest
      // poses differ too much between Daz and Mixamo and produce unnatural
      // claw-like poses.  Keep the avatar's natural rest pose instead.
      const isFingerBone =
        /Hand(Thumb|Index|Middle|Ring|Pinky)/i.test(avatarBoneName) ||
        /FingerBase/i.test(avatarBoneName);
      if (isFingerBone) continue;

      const newName = track.name.replace(animBoneName, avatarBoneName);
      const prop = parsed.propertyName;

      if (prop === "quaternion") {
        // Rotation retargeting: correction * animFrame
        // correction = avatarRest * inverse(animRest)
        // At rest frame this yields avatarRest (identity delta), preserving the avatar's pose.
        const mRestInv = mRest.quaternion.clone().invert();
        const correction = aRest.quaternion.clone().multiply(mRestInv);

        const vals = new Float32Array(track.values.length);
        for (let i = 0; i < track.values.length; i += 4) {
          const q = new THREE.Quaternion(
            track.values[i],
            track.values[i + 1],
            track.values[i + 2],
            track.values[i + 3]
          );
          q.premultiply(correction);
          vals[i] = q.x;
          vals[i + 1] = q.y;
          vals[i + 2] = q.z;
          vals[i + 3] = q.w;
        }
        newTracks.push(
          new THREE.QuaternionKeyframeTrack(newName, track.times, vals)
        );
      } else if (prop === "position") {
        const vals = new Float32Array(track.values.length);
        if (animBoneName === "Hips") {
          // Root bone: retarget position delta in world space
          for (let i = 0; i < track.values.length; i += 3) {
            vals[i] =
              aRest.position.x + (track.values[i] - mRest.position.x);
            vals[i + 1] =
              aRest.position.y + (track.values[i + 1] - mRest.position.y);
            vals[i + 2] =
              aRest.position.z + (track.values[i + 2] - mRest.position.z);
          }
        } else {
          // Child bones: keep avatar rest position (rotation handles the motion)
          for (let i = 0; i < track.values.length; i += 3) {
            vals[i] = aRest.position.x;
            vals[i + 1] = aRest.position.y;
            vals[i + 2] = aRest.position.z;
          }
        }
        newTracks.push(
          new THREE.VectorKeyframeTrack(newName, track.times, vals)
        );
      } else if (prop === "scale") {
        // Scale retargeting: avatarRest * (animFrame / animRest)
        const vals = new Float32Array(track.values.length);
        for (let i = 0; i < track.values.length; i += 3) {
          vals[i] =
            aRest.scale.x * (track.values[i] / (mRest.scale.x || 1));
          vals[i + 1] =
            aRest.scale.y * (track.values[i + 1] / (mRest.scale.y || 1));
          vals[i + 2] =
            aRest.scale.z * (track.values[i + 2] / (mRest.scale.z || 1));
        }
        newTracks.push(
          new THREE.VectorKeyframeTrack(newName, track.times, vals)
        );
      }
    }

    clip.tracks = newTracks;
  });

  console.log(
    "Animation retargeting complete. Bone name mappings:",
    boneNameMap
  );
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
              // Retarget animations to match the avatar's skeleton
              console.log("Retargeting animations to match avatar skeleton...");
              retargetAnimations(animGltf, avatarGroup);

              // Rebuild validNodes after retargeting (track names may have changed)
              validNodes.clear();
              avatarGroup.traverse((node) => {
                if (node.name) validNodes.add(node.name);
              });
            }

            // Filter out tracks targeting bones not in the avatar
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

function getAvatarGroup() {
  return avatarGroup;
}

export { loadAvatar, updateAvatar, getAvatarGroup };
