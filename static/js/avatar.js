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

// Pose editor state — stores references to arm/hand bones for the control panel
let poseBones = {};
let poseRestQuaternions = {};

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
const IDLE_ANIMS = ["Idle"];

// Only load professional animations suitable for a company website
const PROFESSIONAL_ANIMS = new Set([
  "Idle",
  "TalkingOne",
  "TalkingTwo",
  "TalkingThree",
  "DismissingGesture",
  "ThoughtfulHeadShake",
]);

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
  return "Idle";
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

// Bone search patterns shared by pose creation and control panel
// const POSE_BONE_SEARCH = {
//   leftShoulder: ["LeftShoulder", "lCollar", "mixamorig:LeftShoulder"],
//   rightShoulder: ["RightShoulder", "rCollar", "mixamorig:RightShoulder"],
//   leftUpperArm: ["LeftArm", "lShldrBend", "mixamorig:LeftArm"],
//   rightUpperArm: ["RightArm", "rShldrBend", "mixamorig:RightArm"],
//   leftElbow: ["LeftForeArm", "lForearmBend", "mixamorig:LeftForeArm"],
//   rightElbow: ["RightForeArm", "rForearmBend", "mixamorig:RightForeArm"],
//   leftHand: ["LeftHand", "lHand", "mixamorig:LeftHand"],
//   rightHand: ["RightHand", "rHand", "mixamorig:RightHand"],
// };
const POSE_BONE_SEARCH = {
  // Existing arm bones
  leftShoulder:  ["LeftShoulder"],
  rightShoulder: ["RightShoulder"],
  leftUpperArm:  ["LeftArm"],
  rightUpperArm: ["RightArm"],
  leftElbow:     ["LeftForeArm"],
  rightElbow:    ["RightForeArm"],
  leftHand:      ["LeftHand"],
  rightHand:     ["RightHand"],

  // Finger bases
  leftFingerBase:  ["LeftFingerBase"],
  rightFingerBase: ["RightFingerBase"],

  // Left thumb
  leftThumb1: ["LeftHandThumb1"],
  leftThumb2: ["LeftHandThumb2"],
  leftThumb3: ["LeftHandThumb3"],

  // Right thumb
  rightThumb1: ["RightHandThumb1"],
  rightThumb2: ["RightHandThumb2"],
  rightThumb3: ["RightHandThumb3"],

  // Left index
  leftIndex1: ["LeftHandIndex1"],
  leftIndex2: ["LeftHandIndex2"],
  leftIndex3: ["LeftHandIndex3"],

  // Right index
  rightIndex1: ["RightHandIndex1"],
  rightIndex2: ["RightHandIndex2"],
  rightIndex3: ["RightHandIndex3"],

  // Left middle
  leftMiddle1: ["LeftHandMiddle1"],
  leftMiddle2: ["LeftHandMiddle2"],
  leftMiddle3: ["LeftHandMiddle3"],

  // Right middle
  rightMiddle1: ["RightHandMiddle1"],
  rightMiddle2: ["RightHandMiddle2"],
  rightMiddle3: ["RightHandMiddle3"],

  // Left ring
  leftRing1: ["LeftHandRing1"],
  leftRing2: ["LeftHandRing2"],
  leftRing3: ["LeftHandRing3"],

  // Right ring
  rightRing1: ["RightHandRing1"],
  rightRing2: ["RightHandRing2"],
  rightRing3: ["RightHandRing3"],

  // Left pinky
  leftPinky1: ["LeftHandPinky1"],
  leftPinky2: ["LeftHandPinky2"],
  leftPinky3: ["LeftHandPinky3"],

  // Right pinky
  rightPinky1: ["RightHandPinky1"],
  rightPinky2: ["RightHandPinky2"],
  rightPinky3: ["RightHandPinky3"],
};
// Default professional pose delta values (radians)
const DEFAULT_POSE_DELTAS = {
// leftShoulder: { x: 0.13, y: -0.05, z: -0.13 },
// rightShoulder: { x: 0.33, y: 0.60, z: -0.45 },
// leftUpperArm: { x: -0.16, y: 1.03, z: 1.29 },
// rightUpperArm: { x: 0.07, y: -1.42, z: -1.10 },
// leftElbow: { x: -0.93, y: -2.78, z: -0.97 },
// rightElbow: { x: -0.20, y: -0.49, z: -0.73 },
// leftHand: { x: 0.42, y: 1.00, z: -0.24 },
// rightHand: { x: -0.49, y: 1.29, z: 0.31 },
  // leftShoulder:  { x: 0, y: 0, z: 0 },
  // rightShoulder: { x: 0, y: 0, z: 0 },
  // leftUpperArm:  { x: 0, y: 0, z: 0 },
  // rightUpperArm: { x: 0, y: 0, z: 0 },
  // leftElbow:     { x: 0, y: 0, z: 0 },
  // rightElbow:    { x: 0, y: 0, z: 0 },
  // leftHand:      { x: 0, y: 0, z: 0 },
  // rightHand:     { x: 0, y: 0, z: 0 },


  // // Finger bases
  // leftFingerBase:  { x: 0, y: 0, z: 0 },
  // rightFingerBase: { x: 0, y: 0, z: 0 },

  // // Left thumb - slightly curled inward
  // leftThumb1: { x: 0.2,  y: 0.3,  z: 0.4  },
  // leftThumb2: { x: 0.2,  y: 0.0,  z: 0.3  },
  // leftThumb3: { x: 0.1,  y: 0.0,  z: 0.2  },

  // // Right thumb - mirrored
  // rightThumb1: { x: 0.2,  y: -0.3, z: -0.4 },
  // rightThumb2: { x: 0.2,  y: 0.0,  z: -0.3 },
  // rightThumb3: { x: 0.1,  y: 0.0,  z: -0.2 },

  // // Left fingers - slightly curled (clasped pose)
  // leftIndex1:  { x: 0.3, y: 0, z: 0 },
  // leftIndex2:  { x: 0.4, y: 0, z: 0 },
  // leftIndex3:  { x: 0.3, y: 0, z: 0 },

  // leftMiddle1: { x: 0.3, y: 0, z: 0 },
  // leftMiddle2: { x: 0.4, y: 0, z: 0 },
  // leftMiddle3: { x: 0.3, y: 0, z: 0 },

  // leftRing1:   { x: 0.3, y: 0, z: 0 },
  // leftRing2:   { x: 0.4, y: 0, z: 0 },
  // leftRing3:   { x: 0.3, y: 0, z: 0 },

  // leftPinky1:  { x: 0.3, y: 0, z: 0 },
  // leftPinky2:  { x: 0.4, y: 0, z: 0 },
  // leftPinky3:  { x: 0.3, y: 0, z: 0 },

  // // Right fingers - mirrored
  // rightIndex1:  { x: 0.3, y: 0, z: 0 },
  // rightIndex2:  { x: 0.4, y: 0, z: 0 },
  // rightIndex3:  { x: 0.3, y: 0, z: 0 },

  // rightMiddle1: { x: 0.3, y: 0, z: 0 },
  // rightMiddle2: { x: 0.4, y: 0, z: 0 },
  // rightMiddle3: { x: 0.3, y: 0, z: 0 },

  // rightRing1:   { x: 0.3, y: 0, z: 0 },
  // rightRing2:   { x: 0.4, y: 0, z: 0 },
  // rightRing3:   { x: 0.3, y: 0, z: 0 },

  // rightPinky1:  { x: 0.3, y: 0, z: 0 },
  // rightPinky2:  { x: 0.4, y: 0, z: 0 },
  // rightPinky3:  { x: 0.3, y: 0, z: 0 },


  leftShoulder: { x: 0.00, y: 0.00, z: 0.00 },
  rightShoulder: { x: 0.00, y: 0.00, z: 0.00 },
leftUpperArm: { x: 0.00, y: 0.93, z: 1.21 },
rightUpperArm: { x: 0.00, y: -0.93, z: -1.21 },
leftElbow: { x: 0.00, y: 0.00, z: 1.29 },
rightElbow: { x: 0.00, y: 0.00, z: -1.29 },
leftHand: { x: 0.00, y: -1.03, z: 0.00 },
rightHand: { x: 0.00, y: 1.03, z: 0.00 },
leftFingerBase: { x: 0.00, y: 0.00, z: 0.00 },
rightFingerBase: { x: 0.00, y: 0.00, z: 0.00 },
leftThumb1: { x: -1.29, y: 0.45, z: 0.40 },
leftThumb2: { x: 0.20, y: 0.00, z: 0.30 },
leftThumb3: { x: 0.10, y: 0.00, z: 0.20 },
rightThumb1: { x: -1.29, y: -0.45, z: -0.40 },
rightThumb2: { x: 0.20, y: 0.00, z: -0.30 },
rightThumb3: { x: 0.10, y: 0.00, z: -0.20 },
leftIndex1: { x: 0.30, y: 0.00, z: 0.00 },
leftIndex2: { x: 0.40, y: 0.00, z: 0.00 },
leftIndex3: { x: 0.30, y: 0.00, z: 0.00 },
leftMiddle1: { x: 0.30, y: 0.00, z: 0.00 },
leftMiddle2: { x: 0.40, y: 0.00, z: 0.00 },
leftMiddle3: { x: 0.30, y: 0.00, z: 0.00 },
leftRing1: { x: 0.30, y: 0.00, z: 0.00 },
leftRing2: { x: 0.40, y: 0.00, z: 0.00 },
leftRing3: { x: 0.30, y: 0.00, z: 0.00 },
leftPinky1: { x: 0.30, y: 0.00, z: 0.00 },
leftPinky2: { x: 0.40, y: 0.00, z: 0.00 },
leftPinky3: { x: 0.30, y: 0.42, z: 0.60 },
rightIndex1: { x: 0.30, y: 0.00, z: 0.00 },
rightIndex2: { x: 0.40, y: 0.00, z: 0.00 },
rightIndex3: { x: 0.30, y: 0.00, z: 0.00 },
rightMiddle1: { x: 0.30, y: 0.00, z: 0.00 },
rightMiddle2: { x: 0.40, y: 0.00, z: 0.00 },
rightMiddle3: { x: 0.30, y: 0.00, z: 0.00 },
rightRing1: { x: 0.30, y: 0.00, z: 0.00 },
rightRing2: { x: 0.40, y: 0.00, z: 0.00 },
rightRing3: { x: 0.30, y: 0.00, z: 0.00 },
rightPinky1: { x: 0.30, y: 0.00, z: 0.00 },
rightPinky2: { x: 0.40, y: 0.00, z: 0.00 },
rightPinky3: { x: 0.30, y: -0.42, z: -0.60 },
};

function findPoseBones(group) {
  const bones = {};
  group.traverse((node) => {
    for (const [key, names] of Object.entries(POSE_BONE_SEARCH)) {
      if (!bones[key]) {
        for (const n of names) {
          if (node.name === n) {
            bones[key] = node;
            break;
          }
        }
      }
    }
  });
  return bones;
}

function createProfessionalIdleClip(avatarGroup, deltas) {
  const bones = findPoseBones(avatarGroup);

  // Store bone references for the control panel.
  // Only capture rest quaternions on the FIRST call (before any pose is applied)
  // to prevent drift when rebuildIdleWithDeltas re-invokes this function.
  poseBones = bones;
  if (Object.keys(poseRestQuaternions).length === 0) {
    for (const [key, bone] of Object.entries(bones)) {
      poseRestQuaternions[key] = bone.quaternion.clone();
    }
  }

  const foundBones = Object.keys(bones);
  if (foundBones.length === 0) {
    console.warn("Professional idle pose: no arm bones found, skipping");
    return null;
  }
  console.log("Professional idle pose: found bones:", foundBones);

  const poseDeltas = deltas || DEFAULT_POSE_DELTAS;
  const tracks = [];
  const duration = 6.0;
  const times = [0, 3.0, 6.0];

  function addBoneTrack(key, breathX) {
    const bone = bones[key];
    const d = poseDeltas[key];
    if (!bone || !d) return;

    const restQ = poseRestQuaternions[key];
    const delta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(d.x, d.y, d.z)
    );
    const poseQ = restQ.clone().multiply(delta);

    const breathDelta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(breathX || 0, 0, 0)
    );
    const breathQ = poseQ.clone().multiply(breathDelta);

    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        times,
        [
          poseQ.x, poseQ.y, poseQ.z, poseQ.w,
          breathQ.x, breathQ.y, breathQ.z, breathQ.w,
          poseQ.x, poseQ.y, poseQ.z, poseQ.w,
        ]
      )
    );
  }

  addBoneTrack("leftShoulder", 0);
  addBoneTrack("rightShoulder", 0);
  addBoneTrack("leftUpperArm", 0.005);
  addBoneTrack("rightUpperArm", 0.005);
  addBoneTrack("leftElbow", 0);
  addBoneTrack("rightElbow", 0);
  addBoneTrack("leftHand", 0);
  addBoneTrack("rightHand", 0);

// Finger bases
addBoneTrack("leftFingerBase", 0);
addBoneTrack("rightFingerBase", 0);

// Thumbs
addBoneTrack("leftThumb1", 0);
addBoneTrack("leftThumb2", 0);
addBoneTrack("leftThumb3", 0);
addBoneTrack("rightThumb1", 0);
addBoneTrack("rightThumb2", 0);
addBoneTrack("rightThumb3", 0);

// Index
addBoneTrack("leftIndex1", 0);
addBoneTrack("leftIndex2", 0);
addBoneTrack("leftIndex3", 0);
addBoneTrack("rightIndex1", 0);
addBoneTrack("rightIndex2", 0);
addBoneTrack("rightIndex3", 0);

// Middle
addBoneTrack("leftMiddle1", 0);
addBoneTrack("leftMiddle2", 0);
addBoneTrack("leftMiddle3", 0);
addBoneTrack("rightMiddle1", 0);
addBoneTrack("rightMiddle2", 0);
addBoneTrack("rightMiddle3", 0);

// Ring
addBoneTrack("leftRing1", 0);
addBoneTrack("leftRing2", 0);
addBoneTrack("leftRing3", 0);
addBoneTrack("rightRing1", 0);
addBoneTrack("rightRing2", 0);
addBoneTrack("rightRing3", 0);

// Pinky
addBoneTrack("leftPinky1", 0);
addBoneTrack("leftPinky2", 0);
addBoneTrack("leftPinky3", 0);
addBoneTrack("rightPinky1", 0);
addBoneTrack("rightPinky2", 0);
addBoneTrack("rightPinky3", 0);

  if (tracks.length > 0) {
    const clip = new THREE.AnimationClip("Idle", duration, tracks);
    console.log("Professional idle pose animation created with", tracks.length, "bone tracks");
    return clip;
  }

  return null;
}

// Apply pose deltas directly to bones (used by the live control panel)
function applyPoseDeltas(deltas) {
  for (const [key, bone] of Object.entries(poseBones)) {
    const d = deltas[key];
    const restQ = poseRestQuaternions[key];
    if (!bone || !d || !restQ) continue;
    const delta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(d.x, d.y, d.z)
    );
    bone.quaternion.copy(restQ.clone().multiply(delta));
  }
}

// Rebuild the Idle animation clip with new deltas and restart it
function rebuildIdleWithDeltas(deltas) {
  if (!mixer || !avatarGroup) return;
  if (actions["Idle"]) {
    actions["Idle"].stop();
  }
  const clip = createProfessionalIdleClip(avatarGroup, deltas);
  if (clip) {
    actions["Idle"] = mixer.clipAction(clip);
    actions["Idle"].reset().fadeIn(0).play();
    currentAnimation = "Idle";
  }
}

function loadAvatar(targetScene) {
  scene = targetScene;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  return new Promise((resolve, reject) => {
    loader.load(
      "/static/models/newav.glb",
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

        avatarScene.traverse((child) => {
  if (child.isMesh) {
    console.log("MESH:", child.name);
  }
});
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

            // Filter to only professional animations
            animGltf.animations = animGltf.animations.filter(
              (clip) => PROFESSIONAL_ANIMS.has(clip.name)
            );

            animGltf.animations.forEach((clip) => {
              actions[clip.name] = mixer.clipAction(clip);
            });

            // Create professional standing pose (hands clasped in front)
            const professionalClip = createProfessionalIdleClip(avatarGroup);
            if (professionalClip) {
              if (actions["Idle"]) {
                actions["Idle"].stop();
              }
              actions["Idle"] = mixer.clipAction(professionalClip);
            }

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
            // Still apply professional pose even without animations.glb
            mixer = new THREE.AnimationMixer(avatarGroup);
            const fallbackClip = createProfessionalIdleClip(avatarGroup);
            if (fallbackClip) {
              actions["Idle"] = mixer.clipAction(fallbackClip);
              actions["Idle"].reset().fadeIn(0).play();
              currentAnimation = "Idle";
            }
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

export {
  loadAvatar,
  updateAvatar,
  applyPoseDeltas,
  rebuildIdleWithDeltas,
  DEFAULT_POSE_DELTAS,
  POSE_BONE_SEARCH,
};
