/**
 * Pose Controls Module
 * Provides a right-side panel with sliders for Shoulder, Elbow, Forearm, and Hand
 * bone rotations. Includes a "Copy Values" button to export current pose as JSON.
 */

import * as THREE from "three";

let avatarGroupRef = null;
let boneRefs = {};
let boneRestQuaternions = {};
let poseValues = {
  shoulder: { x: 0, y: 0, z: 0 },
  elbow: { x: 0, y: 0, z: 0 },
  forearm: { x: 0, y: 0, z: 0 },
  hand: { x: 0, y: 0, z: 0 },
};

// Common bone name patterns for right arm across different rigs
const BONE_SEARCH = {
  shoulder: [
    "RightShoulder", "Right_Shoulder", "rightShoulder",
    "shoulder_R", "Shoulder_R", "r_shoulder",
    "RightArm", "Right_Arm", "rightArm", "Arm_R",
    "rShldrBend", "rCollar",
  ],
  elbow: [
    "RightForeArm", "Right_ForeArm", "rightForeArm",
    "forearm_R", "ForeArm_R", "r_forearm",
    "RightLowerArm", "Right_LowerArm", "rightLowerArm",
    "rForearmBend",
  ],
  forearm: [
    "RightForeArmTwist", "RightForearmTwist", "Right_ForeArm_Twist",
    "forearm_twist_R", "RightForeArmRoll",
    "rForearmTwist",
    // Fallback: reuse elbow bone for twist if no dedicated twist bone
  ],
  hand: [
    "RightHand", "Right_Hand", "rightHand",
    "hand_R", "Hand_R", "r_hand", "rHand",
  ],
};

function findBone(group, nameList) {
  for (const name of nameList) {
    const bone = group.getObjectByName(name);
    if (bone) return bone;
  }
  // Fuzzy search: try partial match
  let found = null;
  group.traverse((node) => {
    if (found) return;
    if (!node.isBone) return;
    const n = node.name.toLowerCase();
    for (const name of nameList) {
      if (n.includes(name.toLowerCase())) {
        found = node;
        return;
      }
    }
  });
  return found;
}

function discoverBones(group) {
  boneRefs = {};
  boneRestQuaternions = {};

  for (const [key, names] of Object.entries(BONE_SEARCH)) {
    const bone = findBone(group, names);
    if (bone) {
      boneRefs[key] = bone;
      boneRestQuaternions[key] = bone.quaternion.clone();
    }
  }

  // If no dedicated forearm twist bone, share elbow bone for twist
  if (!boneRefs.forearm && boneRefs.elbow) {
    boneRefs.forearm = boneRefs.elbow;
    boneRestQuaternions.forearm = boneRestQuaternions.elbow;
  }

  // Log discovered bones
  const discovered = Object.entries(boneRefs)
    .map(([k, b]) => `${k}: "${b.name}"`)
    .join(", ");
  console.log("Pose Controls - discovered bones:", discovered || "none");

  // List all bones for debugging
  const allBones = [];
  group.traverse((node) => {
    if (node.isBone) allBones.push(node.name);
  });
  console.log("All bones in rig:", allBones);

  return Object.keys(boneRefs).length > 0;
}

function applyPoseTobone(key) {
  const bone = boneRefs[key];
  if (!bone) return;

  const vals = poseValues[key];
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(vals.x),
    THREE.MathUtils.degToRad(vals.y),
    THREE.MathUtils.degToRad(vals.z),
    "XYZ"
  );
  const deltaQ = new THREE.Quaternion().setFromEuler(euler);
  const restQ = boneRestQuaternions[key];

  if (restQ) {
    bone.quaternion.copy(restQ).multiply(deltaQ);
  } else {
    bone.quaternion.setFromEuler(euler);
  }
}

function applyAllPoses() {
  for (const key of Object.keys(poseValues)) {
    applyPoseTobone(key);
  }
}

function createSliderGroup(label, key, axis, min, max) {
  const wrapper = document.createElement("div");
  wrapper.className = "pose-slider-row";

  const lbl = document.createElement("label");
  lbl.textContent = `${label} ${axis.toUpperCase()}`;
  lbl.className = "pose-label";

  const valueSpan = document.createElement("span");
  valueSpan.className = "pose-value";
  valueSpan.textContent = "0";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = min;
  slider.max = max;
  slider.value = 0;
  slider.step = 1;
  slider.className = "pose-slider";

  slider.addEventListener("input", () => {
    const val = parseFloat(slider.value);
    poseValues[key][axis] = val;
    valueSpan.textContent = val.toFixed(0);
    applyPoseTobone(key);
  });

  wrapper.appendChild(lbl);
  wrapper.appendChild(slider);
  wrapper.appendChild(valueSpan);
  return wrapper;
}

function createBoneSection(title, key, description) {
  const section = document.createElement("div");
  section.className = "pose-bone-section";

  const header = document.createElement("div");
  header.className = "pose-bone-header";

  const titleEl = document.createElement("h3");
  titleEl.textContent = title;

  const desc = document.createElement("span");
  desc.className = "pose-bone-desc";
  desc.textContent = description;

  const statusDot = document.createElement("span");
  statusDot.className = "pose-bone-status";
  statusDot.classList.add(boneRefs[key] ? "connected" : "disconnected");
  statusDot.title = boneRefs[key] ? `Bone: ${boneRefs[key].name}` : "Bone not found";

  header.appendChild(titleEl);
  header.appendChild(statusDot);
  section.appendChild(header);
  section.appendChild(desc);

  if (boneRefs[key]) {
    section.appendChild(createSliderGroup(title, key, "x", -180, 180));
    section.appendChild(createSliderGroup(title, key, "y", -180, 180));
    section.appendChild(createSliderGroup(title, key, "z", -180, 180));
  } else {
    const nobone = document.createElement("p");
    nobone.className = "pose-no-bone";
    nobone.textContent = "Bone not found in this model";
    section.appendChild(nobone);
  }

  return section;
}

function buildPosePanel() {
  const panel = document.getElementById("pose-panel");
  if (!panel) return;

  const content = panel.querySelector(".pose-panel-content");
  if (!content) return;

  // Clear existing content
  content.innerHTML = "";

  const sections = [
    { title: "Shoulder", key: "shoulder", desc: "Position arm" },
    { title: "Elbow", key: "elbow", desc: "Bend arm" },
    { title: "Forearm / Twist", key: "forearm", desc: "Rotate inward" },
    { title: "Wrist / Hand", key: "hand", desc: "Fine alignment" },
  ];

  for (const s of sections) {
    content.appendChild(createBoneSection(s.title, s.key, s.desc));
  }

  // Reset button
  const resetBtn = document.createElement("button");
  resetBtn.className = "pose-btn pose-reset-btn";
  resetBtn.textContent = "Reset Pose";
  resetBtn.addEventListener("click", resetPose);
  content.appendChild(resetBtn);
}

function resetPose() {
  for (const key of Object.keys(poseValues)) {
    poseValues[key] = { x: 0, y: 0, z: 0 };
    applyPoseTobone(key);
  }
  // Reset all sliders
  const sliders = document.querySelectorAll(".pose-slider");
  sliders.forEach((s) => { s.value = 0; });
  const values = document.querySelectorAll(".pose-value");
  values.forEach((v) => { v.textContent = "0"; });
}

function copyPoseValues() {
  const output = {};
  for (const [key, vals] of Object.entries(poseValues)) {
    if (boneRefs[key]) {
      output[key] = {
        boneName: boneRefs[key].name,
        rotation: { x: vals.x, y: vals.y, z: vals.z },
      };
    }
  }
  const json = JSON.stringify(output, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    const btn = document.getElementById("copy-pose-btn");
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("copied");
      }, 1500);
    }
  }).catch((err) => {
    console.error("Failed to copy pose values:", err);
    // Fallback: show in prompt
    window.prompt("Pose values (copy manually):", json);
  });
}

function togglePanel() {
  const panel = document.getElementById("pose-panel");
  if (panel) {
    panel.classList.toggle("collapsed");
  }
}

function initPoseControls(avatarGroup) {
  if (!avatarGroup) {
    console.warn("Pose Controls: No avatar group provided");
    return;
  }

  avatarGroupRef = avatarGroup;

  // Wait a frame for skeleton to be ready
  requestAnimationFrame(() => {
    const hasBones = discoverBones(avatarGroup);
    buildPosePanel();

    if (!hasBones) {
      console.warn("Pose Controls: No arm bones found in the model");
    }
  });

  // Wire up copy button
  const copyBtn = document.getElementById("copy-pose-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", copyPoseValues);
  }

  // Wire up toggle button
  const toggleBtn = document.getElementById("pose-toggle-btn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", togglePanel);
  }
}

export { initPoseControls, applyAllPoses };
