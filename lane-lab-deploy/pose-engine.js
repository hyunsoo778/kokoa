const MODULE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";

let landmarker = null;
let loading = null;

async function load() {
  if (landmarker) return landmarker;
  if (loading) return loading;
  loading = (async () => {
    const { FilesetResolver, PoseLandmarker } = await import(MODULE_URL);
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    try {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.62,
        minPosePresenceConfidence: 0.62,
        minTrackingConfidence: 0.6
      });
    } catch {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.58,
        minPosePresenceConfidence: 0.58,
        minTrackingConfidence: 0.55
      });
    }
    return landmarker;
  })();
  return loading;
}

async function detect(video, timestamp) {
  const model = await load();
  return model.detectForVideo(video, timestamp);
}

window.LanePose = { load, detect };
window.dispatchEvent(new CustomEvent("lanepose-ready"));
