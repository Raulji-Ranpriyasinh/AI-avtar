/**
 * Pose Controls Module
 * Provides a right-side panel with sliders for arm bone rotations (both sides).
 * Includes hardcoded default pose and a "Copy Values" button to export as JSON.
 */

import * as THREE from "three";

let avatarGroupRef = null;
let boneRefs = {};
let boneRestQuaternions = {};

// Hardcoded default pose (values in radians)
const HARDCODED_POSE = {
  leftShoulder:  { x: -0.05, y: -0.45, z:  0.00 },
  rightShoulder: { x:  0.00, y: -0.34, z: -0.16 },
  leftUpperArm:  { x:  0.35, y:  1.83, z:  1.15 },
  rightUpperArm: { x:  0.44, y: -1.31, z: -0.96 },
  leftElbow:     { x: -0.60, y: -1.57, z: -0.80 },
  rightElbow:    { x:  0.06, y:  1.18, z: -0.80 },
  leftHand:      { x:  0.20, y: -0.30, z: -0.10 },
  rightHand:     { x:  0.20, y:  0.34, z:  0.10 },
};

// Current pose values (in radians, initialized from hardcoded pose)
let poseValues = {};
for (const [key, val] of Object.entries(HARDCODED_POSE)) {
  poseValues[key] = { x: val.x, y: val.y, z: val.z };
}

// Bone name search patterns for each pose key
const BONE_SEARCH = {
  leftShoulder: [
    "LeftShoulder", "Left_Shoulder", "leftShoulder",
    "shoulder_L", "Shoulder_L", "l_shoulder", "lCollar",
  ],
  rightShoulder: [
    "RightShoulder", "Right_Shoulder", "rightShoulder",
    "shoulder_R", "Shoulder_R", "r_shoulder", "rCollar",
  ],
  leftUpperArm: [
    "LeftArm", "Left_Arm", "leftArm", "LeftUpperArm",
    "Left_UpperArm", "leftUpperArm", "Arm_L",
    "lShldrBend",
  ],
  rightUpperArm: [
    "RightArm", "Right_Arm", "rightArm", "RightUpperArm",
    "Right_UpperArm", "rightUpperArm", "Arm_R",
    "rShldrBend",
  ],
  leftElbow: [
    "LeftForeArm", "Left_ForeArm", "leftForeArm",
    "LeftLowerArm", "Left_LowerArm", "leftLowerArm",
    "forearm_L", "ForeArm_L", "lForearmBend",
  ],
  rightElbow: [
    "RightForeArm", "Right_ForeArm", "rightForeArm",
    "RightLowerArm", "Right_LowerArm", "rightLowerArm",
    "forearm_R", "ForeArm_R", "rForearmBend",
  ],
  leftHand: [
    "LeftHand", "Left_Hand", "leftHand",
    "hand_L", "Hand_L", "l_hand", "lHand",
  ],
  rightHand: [
    "RightHand", "Right_Hand", "rightHand",
    "hand_R", "Hand_R", "r_hand", "rHand",
  ],
};

// UI section definitions
const POSE_SECTIONS = [
  { title: "L Shoulder",   key: "leftShoulder",  desc: "Position left arm" },
  { title: "R Shoulder",   key: "rightShoulder", desc: "Position right arm" },
  { title: "L Upper Arm",  key: "leftUpperArm",  desc: "Rotate left upper arm" },
  { title: "R Upper Arm",  key: "rightUpperArm", desc: "Rotate right upper arm" },
  { title: "L Elbow",      key: "leftElbow",     desc: "Bend left arm" },
  { title: "R Elbow",      key: "rightElbow",    desc: "Bend right arm" },
  { title: "L Hand",       key: "leftHand",      desc: "Fine align left hand" },
  { title: "R Hand",       key: "rightHand",     desc: "Fine align right hand" },
];

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

function applyPoseToBone(key) {
  const bone = boneRefs[key];
  if (!bone) return;

  const vals = poseValues[key];
  const euler = new THREE.Euler(vals.x, vals.y, vals.z, "XYZ");
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
    applyPoseToBone(key);
  }
}

// Slider range in radians: -pi to pi
const SLIDER_MIN = -3.14;
const SLIDER_MAX = 3.14;
const SLIDER_STEP = 0.01;

function createSliderGroup(label, key, axis) {
  const wrapper = document.createElement("div");
  wrapper.className = "pose-slider-row";

  const lbl = document.createElement("label");
  lbl.textContent = `${axis.toUpperCase()}`;
  lbl.className = "pose-label";

  const valueSpan = document.createElement("span");
  valueSpan.className = "pose-value";
  valueSpan.textContent = poseValues[key][axis].toFixed(2);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = SLIDER_MIN;
  slider.max = SLIDER_MAX;
  slider.value = poseValues[key][axis];
  slider.step = SLIDER_STEP;
  slider.className = "pose-slider";
  slider.dataset.key = key;
  slider.dataset.axis = axis;

  slider.addEventListener("input", () => {
    const val = parseFloat(slider.value);
    poseValues[key][axis] = val;
    valueSpan.textContent = val.toFixed(2);
    applyPoseToBone(key);
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
    section.appendChild(createSliderGroup(title, key, "x"));
    section.appendChild(createSliderGroup(title, key, "y"));
    section.appendChild(createSliderGroup(title, key, "z"));
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

  for (const s of POSE_SECTIONS) {
    content.appendChild(createBoneSection(s.title, s.key, s.desc));
  }

  // Reset to hardcoded pose button
  const resetBtn = document.createElement("button");
  resetBtn.className = "pose-btn pose-reset-btn";
  resetBtn.textContent = "Reset to Default Pose";
  resetBtn.addEventListener("click", resetToHardcodedPose);
  content.appendChild(resetBtn);

  // Zero all button
  const zeroBtn = document.createElement("button");
  zeroBtn.className = "pose-btn pose-reset-btn";
  zeroBtn.textContent = "Zero All";
  zeroBtn.addEventListener("click", zeroPose);
  content.appendChild(zeroBtn);
}

function resetToHardcodedPose() {
  for (const [key, val] of Object.entries(HARDCODED_POSE)) {
    poseValues[key] = { x: val.x, y: val.y, z: val.z };
    applyPoseToBone(key);
  }
  syncSlidersToValues();
}

function zeroPose() {
  for (const key of Object.keys(poseValues)) {
    poseValues[key] = { x: 0, y: 0, z: 0 };
    applyPoseToBone(key);
  }
  syncSlidersToValues();
}

function syncSlidersToValues() {
  const sliders = document.querySelectorAll(".pose-slider");
  sliders.forEach((s) => {
    const key = s.dataset.key;
    const axis = s.dataset.axis;
    if (key && axis && poseValues[key]) {
      s.value = poseValues[key][axis];
      const valueSpan = s.parentElement.querySelector(".pose-value");
      if (valueSpan) valueSpan.textContent = poseValues[key][axis].toFixed(2);
    }
  });
}

function copyPoseValues() {
  const output = {};
  for (const [key, vals] of Object.entries(poseValues)) {
    if (boneRefs[key]) {
      output[key] = { x: parseFloat(vals.x.toFixed(2)), y: parseFloat(vals.y.toFixed(2)), z: parseFloat(vals.z.toFixed(2)) };
    }
  }
  const lines = Object.entries(output)
    .map(([k, v]) => `${k}: { x: ${v.x.toFixed(2)}, y: ${v.y.toFixed(2)}, z: ${v.z.toFixed(2)} }`)
    .join("\n");
  navigator.clipboard.writeText(lines).then(() => {
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
    window.prompt("Pose values (copy manually):", lines);
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

    if (hasBones) {
      // Apply hardcoded pose on startup
      applyAllPoses();
      console.log("Pose Controls: Hardcoded default pose applied");
    } else {
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
