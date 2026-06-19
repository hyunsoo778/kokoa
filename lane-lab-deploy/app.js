const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  stream: null,
  facingMode: "environment",
  running: false,
  sound: false,
  frame: 0,
  animationId: null,
  poseBusy: false,
  lastVideoTime: -1,
  lastFrameAt: 0,
  prevWrist: null,
  shot: null,
  trajectory: [],
  smoothedPose: null,
  poseHistory: [],
  poseConfidence: 0,
  videoPoseSummary: null,
  videoAnalysisCompleted: false,
  ballTracker: null,
  lastBallScanAt: 0,
  trackerCanvas: document.createElement("canvas"),
  ballLockArmed: false,
  ballColor: null,
  autoBallLock: null,
  captureMode: localStorage.getItem("lane-lab-capture-mode") || "phone",
  activePatternKey: "house",
  pendingPatternKey: "house",
  trajectoryVisible: true,
  showFinalTrajectory: false,
  lastShotFinishedAt: 0,
  fileVideo: false,
  seekingVideo: false,
  modelReady: false,
  history: JSON.parse(localStorage.getItem("lane-lab-history") || "[]")
};

const video = $("#camera");
const canvas = $("#overlay");
const ctx = canvas.getContext("2d");
const stage = $("#cameraStage");
const cameraButton = $("#cameraButton");
const placeholder = $("#cameraPlaceholder");
const toast = $("#toast");
const lanePatternOverlay = $("#lanePatternOverlay");
let activePatternImage = localStorage.getItem("lane-lab-active-pattern-image") || "";
let patternTextureImage = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function storageSafe(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`저장 실패 · ${key}`, error);
    showToast("저장 공간이 부족해요. 오래된 패턴/기록을 비워주세요.");
    return false;
  }
}

function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function updateVideoPlaybackUI() {
  if (!state.fileVideo) return;
  $("#videoPlayPause").textContent = video.paused ? "▶" : "Ⅱ";
  $("#videoPlayPause").setAttribute("aria-label", video.paused ? "영상 재생" : "영상 일시정지");
  $("#videoCurrentTime").textContent = formatVideoTime(video.currentTime);
  $("#videoDuration").textContent = formatVideoTime(video.duration);
  if (!state.seekingVideo && Number.isFinite(video.duration) && video.duration > 0) {
    $("#videoSeek").value = Math.round(video.currentTime / video.duration * 1000);
  }
}

function resetAnalysisForSeek() {
  state.prevWrist = null;
  state.shot = null;
  state.ballTracker = null;
  state.trajectory = [];
  state.showFinalTrajectory = false;
  state.lastVideoTime = -1;
  state.smoothedPose = null;
  state.poseHistory = [];
  state.autoBallLock = null;
  state.videoPoseSummary = null;
  state.videoAnalysisCompleted = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setFlow("camera");
}

$("#videoPlayPause").addEventListener("click", async () => {
  if (!state.fileVideo) return;
  if (video.paused) {
    if (video.ended) video.currentTime = 0;
    await video.play();
    state.running = true;
    cancelAnimationFrame(state.animationId);
    liveLoop();
  } else {
    video.pause();
  }
  updateVideoPlaybackUI();
});

$("#videoRestart").addEventListener("click", async () => {
  if (!state.fileVideo) return;
  video.currentTime = 0;
  resetAnalysisForSeek();
  await video.play();
  state.running = true;
  cancelAnimationFrame(state.animationId);
  liveLoop();
  updateVideoPlaybackUI();
});

$("#videoSeek").addEventListener("input", event => {
  if (!state.fileVideo || !Number.isFinite(video.duration)) return;
  state.seekingVideo = true;
  video.currentTime = Number(event.target.value) / 1000 * video.duration;
  $("#videoCurrentTime").textContent = formatVideoTime(video.currentTime);
});

$("#videoSeek").addEventListener("change", () => {
  state.seekingVideo = false;
  resetAnalysisForSeek();
  updateVideoPlaybackUI();
});

video.addEventListener("timeupdate", updateVideoPlaybackUI);
video.addEventListener("durationchange", updateVideoPlaybackUI);
video.addEventListener("loadedmetadata", () => {
  setTimeout(() => {
    resizeCanvas();
    renderPatternProjection();
  }, 80);
  if (state.fileVideo && video.videoWidth > video.videoHeight * 1.15 && state.captureMode !== "action") {
    applyCaptureMode("action");
    showToast("가로형 고정 영상을 감지해 액션캠 모드로 전환했어요.");
  }
});
video.addEventListener("play", updateVideoPlaybackUI);
video.addEventListener("pause", updateVideoPlaybackUI);
video.addEventListener("ended", () => {
  if (state.shot) {
    finishLiveShot();
  } else if (!state.videoAnalysisCompleted && state.videoPoseSummary?.frames >= 6) {
    state.shot = state.videoPoseSummary;
    resetBallTracker(state.shot.startedAt || performance.now());
    finishLiveShot();
  } else if (!state.videoAnalysisCompleted) {
    $("#coachTitle").textContent = "투구 동작을 충분히 찾지 못했어요.";
    $("#coachText").textContent = "선수의 머리부터 발끝과 투구 팔이 영상 안에 계속 보이도록 촬영해주세요.";
    drawShotResult(null, null);
    setFlow("result");
    runAnalysisProgress();
  }
  updateVideoPlaybackUI();
  state.smoothedPose = null;
  state.poseHistory = [];
  state.lastVideoTime = -1;
  stage.classList.remove("analyzing");
  $("#modelStatus").textContent = "영상 분석 완료";
  $(".live-badge").innerHTML = "<span></span> 분석 완료";
});

function runAnalysisProgress() {
  const modal = $("#analysisProgressModal");
  const percent = $("#analysisProgressPercent");
  const bar = $("#analysisProgressBar");
  const steps = $$("[data-analysis-step]", modal);
  clearInterval(runAnalysisProgress.timer);
  modal.hidden = false;
  $("#viewAnalysisResult").hidden = true;
  let value = 0;
  const update = () => {
    value = Math.min(100, value + (value < 55 ? 8 : value < 85 ? 5 : 3));
    percent.textContent = `${value}%`;
    bar.style.width = `${value}%`;
    steps.forEach((step, index) => {
      const threshold = [8, 30, 57, 86][index];
      step.classList.toggle("active", value >= threshold && value < threshold + 24);
      step.classList.toggle("done", value >= threshold + 24 || value === 100);
    });
    if (value >= 100) {
      clearInterval(runAnalysisProgress.timer);
      setTimeout(() => {
        modal.hidden = true;
        $("#viewAnalysisResult").hidden = false;
        setFlow("result");
        setPage("coach");
        requestAnimationFrame(() => {
          $("#postureAnalysis").scrollIntoView({ behavior: "smooth", block: "start" });
        });
        showToast("투구 분석이 완료됐어요.");
      }, 350);
    }
  };
  update();
  runAnalysisProgress.timer = setInterval(update, 90);
}

function setPatternOverlayImage(dataUrl, label = "OIL PATTERN", show = true) {
  activePatternImage = dataUrl || "";
  $("#lanePatternImage").src = activePatternImage;
  $("#patternOverlayLabel").textContent = label.toUpperCase();
  $("#togglePatternOverlay").disabled = !activePatternImage;
  $("#patternCalibrateToggle").hidden = !activePatternImage;
  $("#patternPreview").hidden = !activePatternImage;
  $("#overlayControls").hidden = !activePatternImage;
  if (activePatternImage) {
    $("#patternCropPreview").getContext("2d").clearRect(0, 0, 240, 640);
    const previewImage = new Image();
    previewImage.onload = () => {
      const preview = $("#patternCropPreview");
      preview.width = 240;
      preview.height = 640;
      preview.getContext("2d").drawImage(previewImage, 0, 0, preview.width, preview.height);
    };
    previewImage.src = activePatternImage;
    patternTextureImage = new Image();
    patternTextureImage.onload = () => renderPatternProjection();
    patternTextureImage.src = activePatternImage;
    storageSafe("lane-lab-active-pattern-image", activePatternImage);
  } else {
    patternTextureImage = null;
    renderPatternProjection();
    localStorage.removeItem("lane-lab-active-pattern-image");
  }
  lanePatternOverlay.classList.toggle("visible", Boolean(activePatternImage && show));
  $("#togglePatternOverlay").textContent = lanePatternOverlay.classList.contains("visible") ? "표시 중" : "바닥 표시";
}

function interpolateQuad(corners, u, v) {
  const topX = corners.topLeft.x + (corners.topRight.x - corners.topLeft.x) * u;
  const topY = corners.topLeft.y + (corners.topRight.y - corners.topLeft.y) * u;
  const bottomX = corners.bottomLeft.x + (corners.bottomRight.x - corners.bottomLeft.x) * u;
  const bottomY = corners.bottomLeft.y + (corners.bottomRight.y - corners.bottomLeft.y) * u;
  return {
    x: topX + (bottomX - topX) * v,
    y: topY + (bottomY - topY) * v
  };
}

function drawTexturedTriangle(context, image, source, destination) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < .0001) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const e = (
    d0.x * (s1.x * s2.y - s2.x * s1.y) +
    d1.x * (s2.x * s0.y - s0.x * s2.y) +
    d2.x * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const f = (
    d0.y * (s1.x * s2.y - s2.x * s1.y) +
    d1.y * (s2.x * s0.y - s0.x * s2.y) +
    d2.y * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;
  context.save();
  context.beginPath();
  context.moveTo(d0.x, d0.y);
  context.lineTo(d1.x, d1.y);
  context.lineTo(d2.x, d2.y);
  context.closePath();
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function renderPatternProjection() {
  const projection = $("#patternProjectionCanvas");
  const width = stage.clientWidth || 1;
  const height = stage.clientHeight || 1;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  projection.width = Math.round(width * ratio);
  projection.height = Math.round(height * ratio);
  const context = projection.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, projection.width, projection.height);
  if (!patternTextureImage?.complete || !patternTextureImage.naturalWidth) return;

  const corners = Object.fromEntries(
    Object.entries(patternCorners).map(([key, point]) => [key, {
      x: point.x / 100 * width * ratio,
      y: point.y / 100 * height * ratio
    }])
  );
  const columns = 8;
  const rows = 28;
  const sourceWidth = patternTextureImage.naturalWidth;
  const sourceHeight = patternTextureImage.naturalHeight;
  context.imageSmoothingEnabled = true;
  for (let row = 0; row < rows; row++) {
    const v0 = row / rows;
    const v1 = (row + 1) / rows;
    for (let column = 0; column < columns; column++) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const s00 = { x: u0 * sourceWidth, y: v0 * sourceHeight };
      const s10 = { x: u1 * sourceWidth, y: v0 * sourceHeight };
      const s01 = { x: u0 * sourceWidth, y: v1 * sourceHeight };
      const s11 = { x: u1 * sourceWidth, y: v1 * sourceHeight };
      const d00 = interpolateQuad(corners, u0, v0);
      const d10 = interpolateQuad(corners, u1, v0);
      const d01 = interpolateQuad(corners, u0, v1);
      const d11 = interpolateQuad(corners, u1, v1);
      drawTexturedTriangle(context, patternTextureImage, [s00, s10, s11], [d00, d10, d11]);
      drawTexturedTriangle(context, patternTextureImage, [s00, s11, s01], [d00, d11, d01]);
    }
  }
  context.save();
  context.strokeStyle = "rgba(130,165,255,.55)";
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(corners.topLeft.x, corners.topLeft.y);
  context.lineTo(corners.topRight.x, corners.topRight.y);
  context.lineTo(corners.bottomRight.x, corners.bottomRight.y);
  context.lineTo(corners.bottomLeft.x, corners.bottomLeft.y);
  context.closePath();
  context.stroke();
  context.restore();
  renderPatternDistanceScale();
}

function renderPatternDistanceScale() {
  const scale = $("#patternDistanceScale");
  if (!scale) return;
  const marks = [];
  for (let feet = 5; feet <= 60; feet += 5) {
    const v = 1 - feet / 60;
    const left = interpolateQuad(patternCorners, 0, v);
    const right = interpolateQuad(patternCorners, 1, v);
    marks.push(`<span style="--distance-x:${(left.x + (right.x - left.x) * .08).toFixed(2)}%;--distance-y:${(left.y + (right.y - left.y) * .08).toFixed(2)}%">${feet}ft</span>`);
  }
  scale.innerHTML = marks.join("");
}

let tesseractLoader = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoader) return tesseractLoader;
  tesseractLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = () => resolve(window.Tesseract);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return tesseractLoader;
}

function normalizeOcrText(text) {
  return text
    .replace(/[|]/g, "I")
    .replace(/[©®]/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePatternText(rawText, fallbackName) {
  const text = normalizeOcrText(rawText);
  const lengthMatches = [
    /Oil\s*Pattern\s*Distance[^0-9]{0,12}(\d{2})/i,
    /Pattern\s*(?:Distance|Length)[^0-9]{0,12}(\d{2})/i,
    /\b(?:DISTANCE|LENGTH)[^0-9]{0,8}(\d{2})\b/i
  ];
  let length = 0;
  for (const expression of lengthMatches) {
    const match = text.match(expression);
    if (match && Number(match[1]) >= 28 && Number(match[1]) <= 55) {
      length = Number(match[1]);
      break;
    }
  }
  const volumeMatch = text.match(/Volume\s*Oil\s*Total[^0-9]{0,12}(\d{1,2}(?:[.,]\d{1,2})?)/i)
    || text.match(/(?:TOTAL\s*VOLUME|VOLUME)[^0-9]{0,10}(\d{1,2}(?:[.,]\d{1,2})?)\s*m?L/i);
  const ratioCandidates = [...text.matchAll(/\b(1[.:]\d{1,2}|[2-9][.:]\d{1,2})\b/g)]
    .map(match => Number(match[1].replace(":", ".")))
    .filter(value => value >= 1 && value <= 15);
  const titleLine = rawText.split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /\b(20\d{2}|TYPE|OPEN|CHALLENGE|CHAMPIONSHIP|CUP|MASTERS)\b/i.test(line) && line.length < 55);
  const breakpoint = length ? Math.max(3, Math.min(18, length - 31)) : 8;
  const aim = Math.max(breakpoint + 4, Math.min(25, breakpoint + 6));
  const standing = Math.max(aim + 6, Math.min(35, aim + 9));
  const ratio = ratioCandidates.length ? Math.max(...ratioCandidates) : 0;
  const volume = volumeMatch ? Number(volumeMatch[1].replace(",", ".")) : 0;
  const confidenceParts = [Boolean(length), Boolean(volume), Boolean(titleLine)];
  const confidence = confidenceParts.filter(Boolean).length / confidenceParts.length;
  return {
    name: titleLine || fallbackName,
    length,
    volume,
    ratio,
    boards: [standing, aim, breakpoint],
    confidence,
    text
  };
}

function analyzeOilGraph(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  const boardDensity = new Array(39).fill(0);
  for (let board = 0; board < 39; board++) {
    const x0 = Math.floor(board / 39 * width);
    const x1 = Math.max(x0 + 1, Math.floor((board + 1) / 39 * width));
    let colored = 0;
    let count = 0;
    for (let y = Math.floor(height * .35); y < height; y += 4) {
      for (let x = x0; x < x1; x += 2) {
        const index = (y * width + x) * 4;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        if (b > r * 1.15 && b > g * 1.05 && b > 70) colored++;
        count++;
      }
    }
    boardDensity[board] = count ? colored / count : 0;
  }
  const peak = Math.max(...boardDensity);
  const peakBoard = boardDensity.indexOf(peak) + 1;
  const outside = [...boardDensity.slice(0, 7), ...boardDensity.slice(32)].reduce((a,b) => a + b, 0) / 14;
  const middle = boardDensity.slice(14, 25).reduce((a,b) => a + b, 0) / 11;
  const ratio = outside > .002 ? Math.max(1, Math.min(15, middle / outside)) : 0;
  return { peakBoard, ratio, boardDensity };
}

async function recognizePatternDocument(sourceDataUrl, fallbackName) {
  try {
    const Tesseract = await loadTesseract();
    const result = await Tesseract.recognize(sourceDataUrl, "eng", {
      logger: progress => {
        if (progress.status === "recognizing text") {
          $("#patternAnalysisStatus").textContent = `문자 분석 ${Math.round(progress.progress * 100)}%`;
        }
      }
    });
    return parsePatternText(result.data.text, fallbackName);
  } catch (error) {
    console.warn("Pattern OCR failed", error);
    return parsePatternText("", fallbackName);
  }
}

function processPatternImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const narrowGraph = image.width / image.height < .48;
        const source = narrowGraph
          ? { x: 0, y: 0, width: image.width, height: image.height }
          : {
              x: image.width * .64,
              y: image.height * .13,
              width: image.width * .30,
              height: image.height * .70
            };
        const output = document.createElement("canvas");
        output.width = 240;
        output.height = 720;
        const outputContext = output.getContext("2d");
        outputContext.fillStyle = "#bfa260";
        outputContext.fillRect(0, 0, output.width, output.height);
        outputContext.drawImage(
          image,
          source.x, source.y, source.width, source.height,
          0, 0, output.width, output.height
        );
        const graphAnalysis = analyzeOilGraph(output);
        const sourcePixels = outputContext.getImageData(0, 0, output.width, output.height);
        const clean = document.createElement("canvas");
        clean.width = output.width;
        clean.height = output.height;
        const cleanContext = clean.getContext("2d");
        const cleanPixels = cleanContext.createImageData(clean.width, clean.height);
        for (let index = 0; index < sourcePixels.data.length; index += 4) {
          const r = sourcePixels.data[index];
          const g = sourcePixels.data[index + 1];
          const b = sourcePixels.data[index + 2];
          const blueStrength = Math.max(0, b - Math.max(r, g) * .72);
          const cyanStrength = Math.max(0, Math.min(g, b) - r * .72);
          const darkBlue = b > 45 && b > r * 1.08;
          const concentration = Math.max(blueStrength, cyanStrength, darkBlue ? b * .35 : 0);
          const alpha = concentration > 18
            ? Math.min(220, 80 + concentration * 1.15)
            : 42;
          cleanPixels.data[index] = concentration > 18 ? 52 : 72;
          cleanPixels.data[index + 1] = concentration > 18 ? 83 : 105;
          cleanPixels.data[index + 2] = concentration > 18 ? 245 : 225;
          cleanPixels.data[index + 3] = alpha;
        }
        cleanContext.putImageData(cleanPixels, 0, 0);
        cleanContext.globalCompositeOperation = "source-over";
        cleanContext.strokeStyle = "rgba(155,185,255,.14)";
        cleanContext.lineWidth = 1;
        for (let board = 1; board < 39; board++) {
          const x = board / 39 * clean.width;
          cleanContext.beginPath();
          cleanContext.moveTo(x, 0);
          cleanContext.lineTo(x, clean.height);
          cleanContext.stroke();
        }
        resolve({
          overlay: clean.toDataURL("image/png"),
          source: reader.result,
          graph: graphAnalysis
        });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setPatternRenderProgress(value) {
  const modal = $("#patternRenderModal");
  modal.hidden = false;
  $("#patternRenderPercent").textContent = `${value}%`;
  $("#patternRenderBar").style.width = `${value}%`;
  const thresholds = [5, 32, 62, 88];
  $$("[data-pattern-render-step]", modal).forEach((step, index) => {
    step.classList.toggle("active", value >= thresholds[index] && value < (thresholds[index + 1] || 101));
    step.classList.toggle("done", value >= (thresholds[index + 1] || 100));
  });
}

function finishPatternRenderProgress(message = "패턴 렌더링이 완료됐어요.") {
  setPatternRenderProgress(100);
  setTimeout(() => {
    $("#patternRenderModal").hidden = true;
    showToast(message);
  }, 420);
}

async function handlePatternImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  $("#patternSourceSheet").hidden = true;
  try {
    setPatternRenderProgress(5);
    $("#patternAnalysisTitle").textContent = "패턴표 분석 중";
    $("#patternAnalysisStatus").textContent = "오일 그래프를 찾고 있습니다.";
    $("#patternAnalysisResult").hidden = true;
    const processed = await processPatternImage(file);
    setPatternRenderProgress(32);
    const fallbackName = file.name.replace(/\.[^.]+$/, "");
    setPatternOverlayImage(processed.overlay, fallbackName, true);
    const analysis = await recognizePatternDocument(processed.source, fallbackName);
    setPatternRenderProgress(67);
    if (!analysis.ratio && processed.graph.ratio) analysis.ratio = processed.graph.ratio;
    applyAnalyzedPattern(analysis, processed.overlay);
    setPatternRenderProgress(90);
    finishPatternRenderProgress(analysis.length ? "패턴을 보관함에 저장하고 레인에 적용했어요." : "그래프를 적용했어요. 길이는 확인해주세요.");
  } catch {
    $("#patternRenderModal").hidden = true;
    showToast("패턴표 이미지를 읽을 수 없어요.");
  }
  event.target.value = "";
}

$("#patternImageUpload").addEventListener("change", handlePatternImageUpload);
$("#patternCameraUpload").addEventListener("change", handlePatternImageUpload);

$("#togglePatternOverlay").addEventListener("click", () => {
  if (!activePatternImage) return;
  const visible = lanePatternOverlay.classList.toggle("visible");
  $("#togglePatternOverlay").textContent = visible ? "표시 중" : "바닥 표시";
  showToast(visible ? "카메라 레인에 패턴을 표시합니다." : "패턴 표시를 숨겼어요.");
});

$("#removePatternImage").addEventListener("click", () => {
  setPatternOverlayImage("", "", false);
  $("#patternImageUpload").value = "";
  showToast("패턴 이미지를 제거했어요.");
});

const defaultPatternCorners = {
  topLeft: { x: 38, y: 23 },
  topRight: { x: 62, y: 23 },
  bottomLeft: { x: 14, y: 96 },
  bottomRight: { x: 86, y: 96 }
};

let patternCorners = structuredClone(defaultPatternCorners);
let patternEditWasExpanded = false;
let patternEditVideoWasPlaying = false;

function clampPatternCorners(corners) {
  const next = structuredClone(corners);
  Object.values(next).forEach(point => {
    point.x = Math.max(2, Math.min(98, point.x));
    point.y = Math.max(5, Math.min(98, point.y));
  });
  const minimumWidth = 6;
  if (next.topRight.x - next.topLeft.x < minimumWidth) {
    next.topRight.x = Math.min(98, next.topLeft.x + minimumWidth);
  }
  if (next.bottomRight.x - next.bottomLeft.x < minimumWidth) {
    next.bottomRight.x = Math.min(98, next.bottomLeft.x + minimumWidth);
  }
  const topMaxY = Math.min(next.bottomLeft.y, next.bottomRight.y) - 10;
  next.topLeft.y = Math.min(next.topLeft.y, topMaxY);
  next.topRight.y = Math.min(next.topRight.y, topMaxY);
  return next;
}

function updateOverlayControls(save = true) {
  patternCorners = clampPatternCorners(patternCorners);
  const opacity = Math.max(.48, Number($("#cameraPatternOpacity").value) / 100);
  const topY = (patternCorners.topLeft.y + patternCorners.topRight.y) / 2;
  const bottomY = (patternCorners.bottomLeft.y + patternCorners.bottomRight.y) / 2;
  const center = (
    patternCorners.topLeft.x + patternCorners.topRight.x +
    patternCorners.bottomLeft.x + patternCorners.bottomRight.x
  ) / 4;
  lanePatternOverlay.style.setProperty("--pattern-opacity", opacity);
  lanePatternOverlay.style.setProperty("--pattern-center", `${center}%`);
  lanePatternOverlay.style.setProperty("--pattern-top", `${topY}%`);
  lanePatternOverlay.style.setProperty("--pattern-bottom", `${bottomY}%`);
  lanePatternOverlay.style.setProperty("--pattern-top-left", `${patternCorners.topLeft.x}%`);
  lanePatternOverlay.style.setProperty("--pattern-top-right", `${patternCorners.topRight.x}%`);
  lanePatternOverlay.style.setProperty("--pattern-bottom-left", `${patternCorners.bottomLeft.x}%`);
  lanePatternOverlay.style.setProperty("--pattern-bottom-right", `${patternCorners.bottomRight.x}%`);
  lanePatternOverlay.style.setProperty("--pattern-tl-y", `${patternCorners.topLeft.y}%`);
  lanePatternOverlay.style.setProperty("--pattern-tr-y", `${patternCorners.topRight.y}%`);
  lanePatternOverlay.style.setProperty("--pattern-bl-y", `${patternCorners.bottomLeft.y}%`);
  lanePatternOverlay.style.setProperty("--pattern-br-y", `${patternCorners.bottomRight.y}%`);
  renderPatternProjection();
  if (save) {
    storageSafe("lane-lab-overlay-settings", JSON.stringify({ corners: patternCorners, opacity }));
  }
}

$("#cameraPatternOpacity").addEventListener("input", () => updateOverlayControls());

const savedOverlaySettings = JSON.parse(localStorage.getItem("lane-lab-overlay-settings") || "null");
if (savedOverlaySettings?.corners) {
  patternCorners = savedOverlaySettings.corners;
  $("#cameraPatternOpacity").value = Math.max(48, Math.round((savedOverlaySettings.opacity || .58) * 100));
  updateOverlayControls(false);
} else if (savedOverlaySettings?.topWidth) {
  const center = savedOverlaySettings.center || 50;
  patternCorners = {
    topLeft: { x: center - savedOverlaySettings.topWidth / 2, y: Number.parseInt(savedOverlaySettings.top, 10) || 23 },
    topRight: { x: center + savedOverlaySettings.topWidth / 2, y: Number.parseInt(savedOverlaySettings.top, 10) || 23 },
    bottomLeft: { x: center - savedOverlaySettings.bottomWidth / 2, y: Number.parseInt(savedOverlaySettings.bottom, 10) || 96 },
    bottomRight: { x: center + savedOverlaySettings.bottomWidth / 2, y: Number.parseInt(savedOverlaySettings.bottom, 10) || 96 }
  };
  $("#cameraPatternOpacity").value = Math.max(48, Math.round((savedOverlaySettings.opacity || .58) * 100));
  updateOverlayControls();
} else {
  updateOverlayControls();
}
if (activePatternImage) setPatternOverlayImage(activePatternImage, "SAVED PATTERN", true);

$("#patternCalibrateToggle").addEventListener("click", () => {
  const card = $(".camera-card");
  patternEditWasExpanded = card.classList.contains("expanded");
  patternEditVideoWasPlaying = state.fileVideo && !video.paused;
  if (patternEditVideoWasPlaying) video.pause();
  if (!patternEditWasExpanded) {
    card.classList.add("expanded");
    document.body.classList.add("camera-expanded");
    $("#expandCamera").textContent = "✕";
  }
  document.body.classList.add("pattern-edit-mode");
  $("#cameraPatternControls").hidden = false;
  lanePatternOverlay.classList.add("editing");
  stage.classList.add("pattern-editing");
  setTimeout(() => {
    resizeCanvas();
    const markerResult = detectLaneByMarkers();
    if (markerResult) {
      patternCorners = markerResult.corners;
      updateOverlayControls();
      showToast("밝은 마커로 레인을 맞췄어요 · 모서리를 확인해주세요.");
      return;
    }
    const result = autoDetectLane();
    if (result) {
      patternCorners = result.corners;
      updateOverlayControls();
      showToast(result.confidence >= .45
        ? "레인 경계를 자동으로 맞췄어요."
        : "자동으로 배치했어요. 모서리만 확인해주세요.");
    } else {
      showToast("자동 감지 실패 · 파울라인·핀 앞에 밝은 동그라미를 두면 더 잘 잡혀요.");
    }
  }, 180);
});

$("#closePatternControls").addEventListener("click", async () => {
  $("#cameraPatternControls").hidden = true;
  lanePatternOverlay.classList.remove("editing");
  stage.classList.remove("pattern-editing");
  document.body.classList.remove("pattern-edit-mode");
  updateOverlayControls();
  if (!patternEditWasExpanded) {
    $(".camera-card").classList.remove("expanded");
    document.body.classList.remove("camera-expanded");
    $("#expandCamera").textContent = "⛶";
  }
  if (patternEditVideoWasPlaying) {
    await video.play();
    state.running = true;
    cancelAnimationFrame(state.animationId);
    liveLoop();
  }
  setTimeout(resizeCanvas, 120);
  setPatternRenderProgress(62);
  setTimeout(() => finishPatternRenderProgress("레인 보정과 패턴 렌더링이 완료됐어요."), 420);
});

$("#resetPatternCorners").addEventListener("click", () => {
  patternCorners = structuredClone(defaultPatternCorners);
  updateOverlayControls();
  showToast("패턴 위치를 기본값으로 되돌렸어요.");
});

function drawVideoCover(context, width, height) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    video,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

function autoDetectLane() {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const width = 180;
  const height = Math.round(width * stage.clientHeight / stage.clientWidth);
  const scan = document.createElement("canvas");
  scan.width = width;
  scan.height = height;
  const context = scan.getContext("2d", { willReadFrequently: true });
  drawVideoCover(context, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let pixel = 0, index = 0; pixel < gray.length; pixel++, index += 4) {
    gray[pixel] = Math.round(data[index] * .2126 + data[index + 1] * .7152 + data[index + 2] * .0722);
  }

  let poseBox = null;
  const visiblePose = (state.smoothedPose || []).filter(point => point.visibility > .5);
  if (visiblePose.length) {
    const xs = visiblePose.map(point => point.x / stage.clientWidth * width);
    const ys = visiblePose.map(point => point.y / stage.clientHeight * height);
    poseBox = {
      left: Math.max(0, Math.min(...xs) - width * .05),
      right: Math.min(width, Math.max(...xs) + width * .05),
      top: Math.max(0, Math.min(...ys) - height * .04),
      bottom: Math.min(height, Math.max(...ys) + height * .03)
    };
  }

  const blocked = (x, y) => poseBox
    && x >= poseBox.left && x <= poseBox.right
    && y >= poseBox.top && y <= poseBox.bottom;

  const horizontalGradient = (x, y) => {
    const xi = Math.max(2, Math.min(width - 3, Math.round(x)));
    const yi = Math.max(1, Math.min(height - 2, Math.round(y)));
    return Math.abs(gray[yi * width + xi + 2] - gray[yi * width + xi - 2]);
  };

  const verticalGradient = (x, y) => {
    const xi = Math.max(1, Math.min(width - 2, Math.round(x)));
    const yi = Math.max(2, Math.min(height - 3, Math.round(y)));
    return Math.abs(gray[(yi + 2) * width + xi] - gray[(yi - 2) * width + xi]);
  };

  let pinDeckY = Math.round(height * .56);
  let pinDeckScore = -1;
  for (let y = Math.round(height * .38); y <= Math.round(height * .72); y += 2) {
    let score = 0;
    let samples = 0;
    for (let x = Math.round(width * .18); x <= Math.round(width * .82); x += 4) {
      if (blocked(x, y)) continue;
      score += verticalGradient(x, y);
      samples++;
    }
    const average = samples ? score / samples : 0;
    if (average > pinDeckScore) {
      pinDeckScore = average;
      pinDeckY = y;
    }
  }

  const bottomY = height * .965;
  let best = null;
  for (let topOffset = -8; topOffset <= 18; topOffset += 4) {
    const topY = Math.max(height * .36, Math.min(height * .73, pinDeckY + topOffset));
    for (let centerPercent = 36; centerPercent <= 64; centerPercent += 2) {
      const centerX = width * centerPercent / 100;
      for (let topHalfPercent = 5; topHalfPercent <= 18; topHalfPercent += 2) {
        const topHalf = width * topHalfPercent / 100;
        for (let bottomHalfPercent = 25; bottomHalfPercent <= 48; bottomHalfPercent += 3) {
          const bottomHalf = width * bottomHalfPercent / 100;
          if (centerX - bottomHalf < 1 || centerX + bottomHalf > width - 1) continue;
          let edgeScore = 0;
          let edgeSamples = 0;
          let insideBrightness = 0;
          let brightnessSamples = 0;
          for (let step = 0; step <= 30; step++) {
            const progress = step / 30;
            const y = topY + (bottomY - topY) * progress;
            const half = topHalf + (bottomHalf - topHalf) * progress;
            const left = centerX - half;
            const right = centerX + half;
            if (!blocked(left, y)) {
              edgeScore += horizontalGradient(left, y);
              edgeSamples++;
            }
            if (!blocked(right, y)) {
              edgeScore += horizontalGradient(right, y);
              edgeSamples++;
            }
            if (!blocked(centerX, y)) {
              insideBrightness += gray[Math.round(y) * width + Math.round(centerX)];
              brightnessSamples++;
            }
          }
          if (edgeSamples < 20) continue;
          const averageEdge = edgeScore / edgeSamples;
          const averageInside = brightnessSamples ? insideBrightness / brightnessSamples : 0;
          const centerBias = Math.abs(centerPercent - 50) * .22;
          const geometryPenalty = Math.abs(bottomHalfPercent - 36) * .08;
          const score = averageEdge + averageInside * .035 - centerBias - geometryPenalty + pinDeckScore * .08;
          if (!best || score > best.score) {
            best = { score, topY, bottomY, centerX, topHalf, bottomHalf, averageEdge };
          }
        }
      }
    }
  }
  if (!best) return null;
  const toPercentX = value => value / width * 100;
  const toPercentY = value => value / height * 100;
  return {
    corners: {
      topLeft: { x: toPercentX(best.centerX - best.topHalf), y: toPercentY(best.topY) },
      topRight: { x: toPercentX(best.centerX + best.topHalf), y: toPercentY(best.topY) },
      bottomLeft: { x: toPercentX(best.centerX - best.bottomHalf), y: toPercentY(best.bottomY) },
      bottomRight: { x: toPercentX(best.centerX + best.bottomHalf), y: toPercentY(best.bottomY) }
    },
    confidence: Math.max(0, Math.min(1, (best.averageEdge - 8) / 22))
  };
}

function detectLaneByMarkers() {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const width = 180;
  const height = Math.round(width * stage.clientHeight / stage.clientWidth);
  const scan = document.createElement("canvas");
  scan.width = width;
  scan.height = height;
  const context = scan.getContext("2d", { willReadFrequently: true });
  drawVideoCover(context, width, height);
  const data = context.getImageData(0, 0, width, height).data;

  const bright = (r, g, b) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max * 100;
    return max > 198 && min > 150
      || (saturation > 110 && max > 178 && min < 110)
      || max > 232;
  };
  const mask = new Uint8Array(width * height);
  for (let pixel = 0, index = 0; pixel < mask.length; pixel++, index += 4) {
    if (bright(data[index], data[index + 1], data[index + 2])) mask[pixel] = 1;
  }

  const labels = new Int32Array(width * height);
  const blobs = [];
  const stack = [];
  let nextLabel = 1;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel] || labels[pixel]) continue;
    const label = nextLabel++;
    labels[pixel] = label;
    stack.length = 0;
    stack.push(pixel);
    let sumX = 0, sumY = 0, count = 0, minX = width, maxX = 0, minY = height, maxY = 0;
    while (stack.length) {
      const current = stack.pop();
      const cx = current % width;
      const cy = (current - cx) / width;
      sumX += cx; sumY += cy; count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const np = ny * width + nx;
          if (mask[np] && !labels[np]) {
            labels[np] = label;
            stack.push(np);
          }
        }
      }
    }
    blobs.push({
      cx: sumX / count,
      cy: sumY / count,
      count,
      minX, maxX, minY, maxY,
      boxW: maxX - minX + 1,
      boxH: maxY - minY + 1
    });
  }

  const minArea = Math.max(8, Math.round(width * height * .0009));
  const maxArea = width * height * .18;
  const candidates = blobs
    .filter(blob => {
      if (blob.count < minArea || blob.count > maxArea) return false;
      const compactness = blob.count / (blob.boxW * blob.boxH);
      if (compactness < .42) return false;
      if (blob.boxW / blob.boxH > 2.4 || blob.boxH / blob.boxW > 2.4) return false;
      return true;
    })
    .sort((a, b) => b.count - a.count);

  if (!candidates.length) return null;

  const poseBox = (() => {
    const visiblePose = (state.smoothedPose || []).filter(point => point.visibility > .5);
    if (!visiblePose.length) return null;
    const xs = visiblePose.map(point => point.x / stage.clientWidth * width);
    const ys = visiblePose.map(point => point.y / stage.clientHeight * height);
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys)
    };
  })();
  const insidePose = (x, y, pad = 6) => poseBox
    && x >= poseBox.left - pad && x <= poseBox.right + pad
    && y >= poseBox.top - pad && y <= poseBox.bottom + pad;

  const bottomHalf = candidates.filter(blob => blob.cy > height * .5 && !insidePose(blob.cx, blob.cy, 4));
  const topHalf = candidates.filter(blob => blob.cy <= height * .55 && !insidePose(blob.cx, blob.cy, 4));

  let nearMarker = bottomHalf[0];
  let farMarker = topHalf.find(blob => Math.abs(blob.cx - width / 2) < width * .42);

  if (!farMarker) {
    const pinMinX = width * .3;
    const pinMaxX = width * .7;
    const pinMinY = height * .15;
    const pinMaxY = height * .5;
    let pinSumX = 0, pinSumY = 0, pinCount = 0, pinIntensity = 0;
    for (let y = pinMinY; y <= pinMaxY; y++) {
      for (let x = pinMinX; x <= pinMaxX; x++) {
        if (!mask[y * width + x]) continue;
        const idx = (y * width + x) * 4;
        pinSumX += x; pinSumY += y; pinCount++;
        pinIntensity += Math.max(data[idx], data[idx + 1], data[idx + 2]);
      }
    }
    if (pinCount > 6) {
      farMarker = {
        cx: pinSumX / pinCount,
        cy: pinSumY / pinCount,
        count: pinCount,
        boxW: 8,
        boxH: 8,
        isPin: true
      };
    }
  }

  if (!nearMarker || !farMarker) return null;
  if (farMarker.cy >= nearMarker.cy - height * .08) return null;

  const axisX = farMarker.cx - nearMarker.cx;
  const axisY = farMarker.cy - nearMarker.cy;
  const axisLen = Math.hypot(axisX, axisY) || 1;
  const perpX = -axisY / axisLen;
  const perpY = axisX / axisLen;

  const nearRadius = Math.max(nearMarker.boxW, nearMarker.boxH) / 2;
  const farRadius = farMarker.isPin
    ? nearRadius * .42
    : Math.max(farMarker.boxW, farMarker.boxH) / 2;

  const LANE_HALF_RATIO = 6.2;
  const halfNear = nearRadius * LANE_HALF_RATIO;
  const halfFar = farRadius * LANE_HALF_RATIO;

  const bottomL = { x: nearMarker.cx - perpX * halfNear, y: nearMarker.cy - perpY * halfNear };
  const bottomR = { x: nearMarker.cx + perpX * halfNear, y: nearMarker.cy + perpY * halfNear };
  const topL = { x: farMarker.cx - perpX * halfFar, y: farMarker.cy - perpY * halfFar };
  const topR = { x: farMarker.cx + perpX * halfFar, y: farMarker.cy + perpY * halfFar };

  const corners = bottomL.x <= bottomR.x
    ? { bottomLeft: bottomL, bottomRight: bottomR, topLeft: topL, topRight: topR }
    : { bottomLeft: bottomR, bottomRight: bottomL, topLeft: topR, topRight: topL };

  const toPercentX = value => Math.max(2, Math.min(98, value / width * 100));
  const toPercentY = value => Math.max(5, Math.min(98, value / height * 100));
  const centerOffset = Math.abs((nearMarker.cx + farMarker.cx) / 2 - width / 2) / width;
  const sizeConfidence = Math.min(1, nearMarker.count / 60);
  const confidence = Math.max(0, Math.min(.92, .9 - centerOffset * 1.6 - (1 - sizeConfidence) * .25));

  return {
    corners: {
      topLeft: { x: toPercentX(corners.topLeft.x), y: toPercentY(corners.topLeft.y) },
      topRight: { x: toPercentX(corners.topRight.x), y: toPercentY(corners.topRight.y) },
      bottomLeft: { x: toPercentX(corners.bottomLeft.x), y: toPercentY(corners.bottomLeft.y) },
      bottomRight: { x: toPercentX(corners.bottomRight.x), y: toPercentY(corners.bottomRight.y) }
    },
    confidence,
    viaMarkers: true
  };
}

$("#autoFitPattern").addEventListener("click", () => {
  const markerResult = detectLaneByMarkers();
  if (markerResult) {
    patternCorners = markerResult.corners;
    updateOverlayControls();
    showToast("밝은 마커로 레인을 맞췄어요 · 모서리를 확인해주세요.");
    return;
  }
  const result = autoDetectLane();
  if (!result) {
    showToast("마커·레인 경계를 찾지 못했어요. 파울라인과 핀 앞에 밝은 동그라미를 두면 더 잘 잡혀요.");
    return;
  }
  patternCorners = result.corners;
  updateOverlayControls();
  const confidence = Math.round(result.confidence * 100);
  showToast(confidence >= 45
    ? `레인을 자동으로 맞췄어요 · 신뢰도 ${confidence}%`
    : `자동 맞춤 완료 · 모서리를 조금 확인해주세요 (${confidence}%)`);
});

let patternDrag = null;

function pointerPercent(event) {
  const rect = lanePatternOverlay.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * 100,
    y: (event.clientY - rect.top) / rect.height * 100
  };
}

$$(".pattern-handle").forEach(handle => {
  handle.addEventListener("pointerdown", event => {
    if (!lanePatternOverlay.classList.contains("editing")) return;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    patternDrag = { type: "corner", corner: handle.dataset.corner, pointerId: event.pointerId };
  });
});

$("#patternTouchSurface").addEventListener("pointerdown", event => {
  if (!lanePatternOverlay.classList.contains("editing")) return;
  event.preventDefault();
  const point = pointerPercent(event);
  event.currentTarget.setPointerCapture(event.pointerId);
  patternDrag = {
    type: "move",
    pointerId: event.pointerId,
    start: point,
    corners: structuredClone(patternCorners)
  };
});

lanePatternOverlay.addEventListener("pointermove", event => {
  if (!patternDrag || patternDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = pointerPercent(event);
  if (patternDrag.type === "corner") {
    patternCorners[patternDrag.corner] = point;
  } else {
    const dx = point.x - patternDrag.start.x;
    const dy = point.y - patternDrag.start.y;
    patternCorners = Object.fromEntries(
      Object.entries(patternDrag.corners).map(([key, value]) => [key, { x: value.x + dx, y: value.y + dy }])
    );
  }
  updateOverlayControls(false);
});

function finishPatternDrag(event) {
  if (!patternDrag || patternDrag.pointerId !== event.pointerId) return;
  patternDrag = null;
  updateOverlayControls();
}

lanePatternOverlay.addEventListener("pointerup", finishPatternDrag);
lanePatternOverlay.addEventListener("pointercancel", finishPatternDrag);

$("#ballLockToggle").addEventListener("click", () => {
  state.ballLockArmed = !state.ballLockArmed;
  stage.classList.toggle("ball-locking", state.ballLockArmed);
  $("#ballLockToggle").classList.toggle("armed", state.ballLockArmed);
  $("#ballLockToggle").textContent = state.ballLockArmed ? "공을 눌러주세요" : (state.ballColor ? "공 지정됨" : "공 지정(선택)");
});

stage.addEventListener("click", event => {
  if (!state.ballLockArmed || video.readyState < 2) return;
  if (event.target.closest("button, .camera-pattern-controls")) return;
  const rect = stage.getBoundingClientRect();
  const stagePoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const tracker = state.trackerCanvas;
  const tw = 216;
  const th = Math.round(tw * (video.videoHeight || 1920) / (video.videoWidth || 1080));
  tracker.width = tw;
  tracker.height = th;
  const tctx = tracker.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(video, 0, 0, tw, th);
  const point = stageToTracker(stagePoint, tw, th);
  const sampleX = Math.max(2, Math.min(tw - 3, Math.round(point.x)));
  const sampleY = Math.max(2, Math.min(th - 3, Math.round(point.y)));
  const sample = tctx.getImageData(sampleX - 2, sampleY - 2, 5, 5).data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let index = 0; index < sample.length; index += 4) {
    r += sample[index];
    g += sample[index + 1];
    b += sample[index + 2];
    count++;
  }
  state.ballColor = { r: r / count, g: g / count, b: b / count };
  state.ballLockArmed = false;
  stage.classList.remove("ball-locking");
  $("#ballLockToggle").classList.remove("armed");
  $("#ballLockToggle").textContent = "공 지정됨";
  showToast("공 색상을 기억했습니다. 이제 투구해주세요.");
});

function setPage(id) {
  $$(".page").forEach(page => page.classList.toggle("active", page.id === id));
  $$(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.target === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$(".bottom-nav button").forEach(button => button.addEventListener("click", () => setPage(button.dataset.target)));
$$("[data-go]").forEach(button => button.addEventListener("click", () => setPage(button.dataset.go)));

function resizeCanvas() {
  const rect = stage.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  renderPatternProjection();
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function setFlow(step) {
  const order = ["camera", "pose", "coach", "result"];
  const activeIndex = order.indexOf(step);
  $$(".analysis-flow span").forEach((item, index) => item.classList.toggle("active", index <= activeIndex));
}

async function preparePoseModel() {
  const status = $("#modelStatus");
  status.textContent = "AI 모델 준비 중";
  try {
    if (!window.LanePose) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("engine timeout")), 10000);
        window.addEventListener("lanepose-ready", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    await window.LanePose.load();
    state.modelReady = true;
    status.innerHTML = "AI 준비됨 · <b>POSE</b>";
  } catch (error) {
    state.modelReady = false;
    status.textContent = "AI 연결 필요";
    console.warn("Pose model unavailable", error);
  }
}

preparePoseModel();

function drawGuide(progress = 0, live = false) {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  ctx.clearRect(0, 0, w, h);

  ctx.save();
  ctx.strokeStyle = "rgba(201,255,61,.18)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(w * .08, h * .86);
  ctx.lineTo(w * .92, h * .86);
  ctx.stroke();
  ctx.fillStyle = "rgba(201,255,61,.65)";
  ctx.font = "8px sans-serif";
  ctx.fillText("FOUL LINE", w * .08, h * .86 - 7);

  const sway = live ? Math.sin(state.frame * .035) * w * .012 : Math.sin(progress * Math.PI) * w * .04;
  const baseX = w * .48 + sway;
  const baseY = h * .74;
  const points = {
    head: [baseX - w * .04, baseY - h * .49],
    shoulder: [baseX, baseY - h * .38],
    elbow: [baseX + w * (.16 + progress * .08), baseY - h * (.27 + progress * .12)],
    wrist: [baseX + w * (.24 + progress * .16), baseY - h * (.11 + progress * .18)],
    hip: [baseX - w * .01, baseY - h * .18],
    knee1: [baseX - w * (.09 + progress * .02), baseY + h * .01],
    ankle1: [baseX - w * .22, baseY + h * .13],
    knee2: [baseX + w * .08, baseY + h * .01],
    ankle2: [baseX + w * .18, baseY + h * .12]
  };
  const links = [["head","shoulder"],["shoulder","elbow"],["elbow","wrist"],["shoulder","hip"],["hip","knee1"],["knee1","ankle1"],["hip","knee2"],["knee2","ankle2"]];
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  links.forEach(([a,b], index) => {
    ctx.strokeStyle = index === 2 ? "#c9ff3d" : "rgba(80,217,205,.88)";
    ctx.beginPath();
    ctx.moveTo(...points[a]);
    ctx.lineTo(...points[b]);
    ctx.stroke();
  });
  Object.values(points).forEach(([x,y]) => {
    ctx.fillStyle = "#07110f";
    ctx.strokeStyle = "#c9ff3d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.restore();
}

const POSE_CONNECTIONS = [
  [0,11],[0,12],[11,12],
  [11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28]
];
const LEFT_POSE_POINTS = new Set([11,13,15,23,25,27]);
const RIGHT_POSE_POINTS = new Set([12,14,16,24,26,28]);
const PRIMARY_POSE_POINTS = [0,11,12,13,14,15,16,23,24,25,26,27,28];
const LEFT_POSE_COLOR = "#ff9a45";
const RIGHT_POSE_COLOR = "#47dc8b";

function mapLandmark(point) {
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const sourceW = video.videoWidth || stageW;
  const sourceH = video.videoHeight || stageH;
  const scale = Math.max(stageW / sourceW, stageH / sourceH);
  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  return {
    x: point.x * renderedW - (renderedW - stageW) / 2,
    y: point.y * renderedH - (renderedH - stageH) / 2,
    z: point.z,
    visibility: point.visibility ?? 1
  };
}

function angleAt(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const denominator = Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y);
  if (!denominator) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ba.x * bc.x + ba.y * bc.y) / denominator))) * 180 / Math.PI;
}

function drawPose(landmarks) {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const rawPoints = landmarks.map(mapLandmark);
  state.poseHistory.push(rawPoints);
  state.poseHistory = state.poseHistory.slice(-3);
  const medianPoints = rawPoints.map((point, index) => {
    if ([15,16].includes(index) || state.poseHistory.length < 3) return point;
    const samples = state.poseHistory.map(frame => frame[index]).filter(Boolean);
    const middle = values => values.sort((a,b) => a - b)[Math.floor(values.length / 2)];
    return {
      x: middle(samples.map(sample => sample.x)),
      y: middle(samples.map(sample => sample.y)),
      z: middle(samples.map(sample => sample.z)),
      visibility: point.visibility
    };
  });
  if (!state.smoothedPose || state.smoothedPose.length !== medianPoints.length) {
    state.smoothedPose = medianPoints;
  } else {
    const torsoScale = Math.max(24, Math.hypot(
      medianPoints[11].x - medianPoints[24].x,
      medianPoints[11].y - medianPoints[24].y
    ));
    state.smoothedPose = medianPoints.map((point, index) => {
      const previous = state.smoothedPose[index];
      const fastJoint = [13,14,15,16].includes(index);
      const alpha = point.visibility > .82 ? (fastJoint ? .56 : .34) : (fastJoint ? .24 : .10);
      const jump = Math.hypot(point.x - previous.x, point.y - previous.y);
      const maximumJump = torsoScale * (fastJoint ? .78 : .48);
      if (jump > maximumJump && point.visibility < .92) {
        return { ...previous, visibility: point.visibility };
      }
      return {
        x: previous.x + (point.x - previous.x) * alpha,
        y: previous.y + (point.y - previous.y) * alpha,
        z: previous.z + (point.z - previous.z) * alpha,
        visibility: point.visibility
      };
    });
  }
  const points = state.smoothedPose;
  const poseConfidence = PRIMARY_POSE_POINTS.reduce((sum, index) => sum + Math.max(0, Math.min(1, points[index]?.visibility || 0)), 0) / PRIMARY_POSE_POINTS.length;
  state.poseConfidence = poseConfidence;
  stage.dataset.poseQuality = poseConfidence >= .72 ? "good" : poseConfidence >= .58 ? "fair" : "low";
  ctx.clearRect(0, 0, w, h);
  ctx.save();

  ctx.strokeStyle = "rgba(201,255,61,.22)";
  ctx.setLineDash([5, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w * .06, h * .87);
  ctx.lineTo(w * .94, h * .87);
  ctx.stroke();
  ctx.setLineDash([]);

  POSE_CONNECTIONS.forEach(([a, b]) => {
    if (points[a].visibility < .58 || points[b].visibility < .58) return;
    const head = a === 0 || b === 0;
    const leftSide = LEFT_POSE_POINTS.has(a) && LEFT_POSE_POINTS.has(b);
    const rightSide = RIGHT_POSE_POINTS.has(a) && RIGHT_POSE_POINTS.has(b);
    ctx.strokeStyle = leftSide ? LEFT_POSE_COLOR : rightSide ? RIGHT_POSE_COLOR : head ? "rgba(255,255,255,.82)" : "rgba(80,217,205,.72)";
    ctx.lineWidth = leftSide || rightSide ? 2.5 : head ? 1.8 : 1.7;
    ctx.beginPath();
    ctx.moveTo(points[a].x, points[a].y);
    ctx.lineTo(points[b].x, points[b].y);
    ctx.stroke();
  });

  const visiblePosePoints = new Set(PRIMARY_POSE_POINTS);
  points.forEach((point, index) => {
    if (!visiblePosePoints.has(index) || point.visibility < .62) return;
    ctx.fillStyle = "#07110f";
    ctx.strokeStyle = LEFT_POSE_POINTS.has(index) ? LEFT_POSE_COLOR : RIGHT_POSE_POINTS.has(index) ? RIGHT_POSE_COLOR : "#f2f6f4";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, index <= 8 ? 4.2 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  [[27, "L", LEFT_POSE_COLOR], [28, "R", RIGHT_POSE_COLOR]].forEach(([index, label, color]) => {
    const point = points[index];
    if (!point || point.visibility < .48) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(point.x - 9, point.y - 27, 18, 17, 5);
    ctx.fill();
    ctx.fillStyle = "#07110f";
    ctx.font = "900 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, point.x, point.y - 18.5);
  });

  if (points[0].visibility > .62 && points[11].visibility > .62 && points[12].visibility > .62) {
    const headCenter = {
      x: (points[11].x + points[12].x) / 2,
      y: (points[11].y + points[12].y) / 2
    };
    const direction = {
      x: points[0].x - headCenter.x,
      y: points[0].y - headCenter.y
    };
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(headCenter.x, headCenter.y);
    ctx.lineTo(headCenter.x + direction.x * 1.8, headCenter.y + direction.y * 1.8);
    ctx.stroke();
  }

  const trajectoryTravel = state.trajectory.length > 2
    ? Math.hypot(
        state.trajectory[state.trajectory.length - 1].x - state.trajectory[0].x,
        state.trajectory[state.trajectory.length - 1].y - state.trajectory[0].y
      )
    : 0;
  if (state.showFinalTrajectory && state.ballTracker?.valid && state.trajectory.length >= 8 && trajectoryTravel > 40) {
    const line = smoothTrajectory(state.trajectory);
    const motion = analyzeShotTrajectory(state.trajectory);
    drawSegmentedTrajectory(ctx, line, motion.breakIndex, motion.entryIndex, {
      lineWidth: 3,
      glow: true,
      endBall: true
    });
  } else if (state.ballTracker?.confirmed && state.trajectory.length >= 3) {
    const line = smoothTrajectory(state.trajectory);
    const motion = analyzeShotTrajectory(state.trajectory);
    if (motion.valid) {
      drawSegmentedTrajectory(ctx, line, motion.breakIndex, motion.entryIndex, {
        lineWidth: 2.4,
        glow: true,
        endBall: true
      });
    } else {
      ctx.strokeStyle = "rgba(201,255,61,.52)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      line.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.stroke();
      ctx.setLineDash([]);
      const ball = state.ballTracker.currentStage || line[line.length - 1];
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.fillStyle = "#35d6c8";
      ctx.lineWidth = 2;
      ctx.shadowColor = "#35d6c8";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  } else if (state.ballTracker?.detected && state.ballTracker.currentStage) {
    const ball = state.ballTracker.currentStage;
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.fillStyle = "#35d6c8";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#35d6c8";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
  return points;
}

function laneBoundsAtStageY(y) {
  const height = stage.clientHeight;
  const width = stage.clientWidth;
  const calibrated = patternCorners.topLeft.y > 1
    && patternCorners.bottomLeft.y > patternCorners.topLeft.y;
  if (!calibrated) {
    return { left: width * .08, right: width * .92, topY: height * .02, bottomY: height * .98 };
  }
  const topPercent = (patternCorners.topLeft.y + patternCorners.topRight.y) / 2;
  const bottomPercent = (patternCorners.bottomLeft.y + patternCorners.bottomRight.y) / 2;
  const topY = height * topPercent / 100;
  const bottomY = height * bottomPercent / 100;
  if (y < topY || y > bottomY) return null;
  const progress = (y - topY) / Math.max(1, bottomY - topY);
  const leftPercent = patternCorners.topLeft.x + (patternCorners.bottomLeft.x - patternCorners.topLeft.x) * progress;
  const rightPercent = patternCorners.topRight.x + (patternCorners.bottomRight.x - patternCorners.topRight.x) * progress;
  return { left: width * leftPercent / 100, right: width * rightPercent / 100, topY, bottomY };
}

function isInsideLane(point, margin = 10) {
  const bounds = laneBoundsAtStageY(point.y);
  return Boolean(bounds && point.x >= bounds.left - margin && point.x <= bounds.right + margin);
}

function validateTrajectory(points) {
  const profile = trackingProfile();
  if (points.length < profile.minTrackFrames) return { valid: false, reason: "프레임 부족" };
  const line = smoothTrajectory(points);
  const first = line[0];
  const last = line[line.length - 1];
  const verticalTravel = first.y - last.y;
  const duration = (last.time - first.time) / 1000;
  let forwardSteps = 0;
  let laneSteps = 0;
  let jumpSteps = 0;
  for (let index = 1; index < line.length; index++) {
    if (line[index].y < line[index - 1].y + 2) forwardSteps++;
    if (isInsideLane(line[index], 4)) laneSteps++;
    if (Math.hypot(line[index].x - line[index - 1].x, line[index].y - line[index - 1].y) > stage.clientWidth * .13) jumpSteps++;
  }
  const steps = line.length - 1;
  const forwardRatio = forwardSteps / steps;
  const laneRatio = laneSteps / steps;
  const valid = verticalTravel > stage.clientHeight * profile.minTravel
    && duration >= .65
    && duration <= profile.maxDuration
    && forwardRatio >= .62
    && laneRatio >= .55
    && jumpSteps <= 2;
  return { valid, verticalTravel, duration, forwardRatio, laneRatio };
}

function stagePointToLaneData(point) {
  const bounds = laneBoundsAtStageY(point.y);
  if (!bounds) return null;
  const width = Math.max(1, bounds.right - bounds.left);
  const horizontal = Math.max(0, Math.min(1, (point.x - bounds.left) / width));
  const board = 1 + (1 - horizontal) * 38;
  const laneProgress = Math.max(0, Math.min(1, (bounds.bottomY - point.y) / Math.max(1, bounds.bottomY - bounds.topY)));
  return { board, feet: laneProgress * 60, progress: laneProgress };
}

function analyzeShotTrajectory(points, speed) {
  const validation = validateTrajectory(points);
  const line = smoothTrajectory(points);
  const lanePoints = line.map((point, index) => ({
    ...point,
    index,
    lane: stagePointToLaneData(point)
  })).filter(point => point.lane);
  if (lanePoints.length < 5) return { valid: false, validation };
  const laneTravel = lanePoints[lanePoints.length - 1].lane.feet - lanePoints[0].lane.feet;
  const partial = !validation.valid
    && lanePoints.length >= 5
    && laneTravel >= 6
    && (validation.forwardRatio || 0) >= .5
    && (validation.laneRatio || 0) >= .45;
  if (!validation.valid && !partial) return { valid: false, validation };
  validation.partial = partial;

  let breakCandidate = lanePoints[Math.floor(lanePoints.length * .65)];
  let bestCurveScore = -Infinity;
  let totalHeadingChange = 0;
  let headingSamples = 0;
  for (let index = 2; index < lanePoints.length - 2; index++) {
    const current = lanePoints[index];
    const before = lanePoints[index - 2];
    const after = lanePoints[index + 2];
    const headingBefore = Math.atan2(current.x - before.x, before.y - current.y);
    const headingAfter = Math.atan2(after.x - current.x, current.y - after.y);
    const curve = Math.abs(headingAfter - headingBefore);
    totalHeadingChange += curve;
    headingSamples++;
    if (current.lane.feet < 28 || current.lane.feet > 52) continue;
    const lateralExtremity = Math.abs(current.lane.board - lanePoints[0].lane.board) * .02;
    const score = curve + lateralExtremity;
    if (score > bestCurveScore) {
      bestCurveScore = score;
      breakCandidate = current;
    }
  }

  const entryWindow = lanePoints.slice(-Math.min(6, lanePoints.length));
  const entryStart = entryWindow[0];
  const entryEnd = entryWindow[entryWindow.length - 1];
  const laneHeightPixels = Math.max(1, laneBoundsAtStageY(entryStart.y)?.bottomY - laneBoundsAtStageY(entryStart.y)?.topY);
  const laneWidthPixels = Math.max(1, laneBoundsAtStageY(entryStart.y)?.right - laneBoundsAtStageY(entryStart.y)?.left);
  const physicalDx = (entryEnd.x - entryStart.x) / laneWidthPixels * 1.0668;
  const physicalDy = (entryStart.y - entryEnd.y) / laneHeightPixels * 18.29;
  const entryAngle = Math.max(0, Math.min(20, Math.atan2(Math.abs(physicalDx), Math.abs(physicalDy)) * 180 / Math.PI));
  const nearestAtFeet = target => lanePoints.reduce((nearest, point) =>
    Math.abs(point.lane.feet - target) < Math.abs(nearest.lane.feet - target) ? point : nearest
  , lanePoints[0]);
  const speedBetween = (from, to) => {
    const seconds = Math.max(.001, (to.time - from.time) / 1000);
    const meters = Math.abs(to.lane.feet - from.lane.feet) * .3048;
    const measured = meters / seconds * 3.6;
    return measured >= 5 && measured <= 45 ? measured : 0;
  };
  const segmentSize = Math.max(2, Math.min(5, Math.floor(lanePoints.length / 4)));
  const measuredStartSpeed = speedBetween(lanePoints[0], lanePoints[segmentSize]);
  const measuredEndSpeed = speedBetween(lanePoints[lanePoints.length - 1 - segmentSize], lanePoints[lanePoints.length - 1]);
  const startSpeed = measuredStartSpeed || speed || 0;
  const endSpeed = measuredEndSpeed || (startSpeed ? startSpeed * .92 : 0);

  const breakIndex = breakCandidate.index;
  const entryIndex = entryEnd.index;
  const duration = (lanePoints[lanePoints.length - 1].time - lanePoints[0].time) / 1000;
  const curveRate = headingSamples && duration > 0
    ? totalHeadingChange / headingSamples / Math.max(.001, duration) * lanePoints.length
    : 0;
  return {
    valid: true,
    validation,
    line: lanePoints,
    release: lanePoints[0],
    breakpoint: breakCandidate,
    entry: entryEnd,
    breakIndex,
    entryIndex,
    aim: nearestAtFeet(15),
    guide: nearestAtFeet(6),
    entryAngle,
    curveRate,
    speed,
    startSpeed,
    endSpeed,
    duration
  };
}

function drawShotResult(motion, result) {
  const canvas = $("#resultTrajectoryCanvas");
  const context = canvas.getContext("2d");
  const displayWidth = canvas.clientWidth || 300;
  const displayHeight = canvas.clientHeight || 460;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(displayWidth * ratio);
  canvas.height = Math.round(displayHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, displayWidth, displayHeight);

  $$(".result-point").forEach(point => point.classList.remove("visible"));
  $("#myLineLegend")?.classList.toggle("visible", false);
  if (!motion?.valid) {
    $("#trackingQuality").textContent = "궤적 미확정";
    $("#trackingQuality").className = "tracking-quality fail";
    ["resultBallSpeed", "resultBreakBoard", "resultEntryBoard", "resultEntryAngle", "resultAimBoard", "resultGuideBoard"].forEach(id => $(`#${id}`).textContent = "—");
    $("#resultBreakDistance").textContent = "— ft";
    $("#resultSpeedRange").textContent = "시작 → 종료";
    $("#resultTrackFrames").textContent = "0";
    $("#resultTrackTime").textContent = "—초";
    $("#resultRpm").textContent = "—";
    $("#rpmNote").textContent = "궤적 미확정";
    drawShotRadarCard(null);
    return;
  }

  const mapPoint = point => ({
    x: 18 + (39 - point.lane.board) / 38 * (displayWidth - 36),
    y: displayHeight - 18 - point.lane.progress * (displayHeight - 54)
  });
  const mapped = motion.line.map(mapPoint);
  const myLane = computeMyLane(state.history);
  if (myLane) {
    const releasePt = mapPoint(motion.release);
    const breakPt = mapPoint({ lane: { board: myLane.breakBoard, progress: motion.breakpoint.lane.progress } });
    const entryPt = mapPoint({ lane: { board: myLane.entryBoard, progress: motion.entry.lane.progress } });
    context.save();
    context.strokeStyle = "rgba(244,247,242,.4)";
    context.lineWidth = 2;
    context.setLineDash([4, 6]);
    context.beginPath();
    context.moveTo(releasePt.x, releasePt.y);
    context.quadraticCurveTo(breakPt.x, breakPt.y, entryPt.x, entryPt.y);
    context.stroke();
    context.setLineDash([]);
    context.restore();
    $("#myLineLegend")?.classList.toggle("visible", true);
    const myLineNote = $("#resultMyLineNote");
    if (myLineNote) {
      const diff = motion.breakpoint.lane.board - myLane.breakBoard;
      myLineNote.textContent = `BP가 평소 ${diff > 0 ? "바깥" : "안쪽"} ${Math.abs(diff).toFixed(1)}보드`;
    }
  } else {
    const myLineNote = $("#resultMyLineNote");
    if (myLineNote) myLineNote.textContent = "샷 4개 누적 시 평소 라인 비교";
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(7,17,15,.42)";
  context.lineWidth = 10;
  context.beginPath();
  mapped.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  drawSegmentedTrajectory(context, mapped, motion.breakIndex, motion.entryIndex, {
    lineWidth: 4,
    glow: true,
    markers: false,
    endBall: false
  });

  const resultPoints = [
    ["resultReleasePoint", motion.release],
    ["resultBreakPoint", motion.breakpoint],
    ["resultEntryPoint", motion.entry]
  ];
  resultPoints.forEach(([id, point]) => {
    const mappedPoint = mapPoint(point);
    const element = $(`#${id}`);
    element.style.left = `${mappedPoint.x}px`;
    element.style.top = `${mappedPoint.y}px`;
    element.classList.add("visible");
  });

  const rpm = estimateRpm(motion);
  $("#trackingQuality").textContent = motion.validation.partial
    ? `부분 궤적 · ${Math.round(motion.validation.forwardRatio * 100)}%`
    : `궤적 확정 · ${Math.round(motion.validation.forwardRatio * 100)}%`;
  $("#trackingQuality").className = motion.validation.partial ? "tracking-quality" : "tracking-quality good";
  $("#resultBallSpeed").textContent = motion.speed ? motion.speed.toFixed(1) : "—";
  $("#resultSpeedRange").textContent = motion.startSpeed
    ? `${motion.startSpeed.toFixed(1)} → ${motion.endSpeed.toFixed(1)} km/h`
    : "속도 측정 실패";
  $("#resultBreakBoard").textContent = motion.breakpoint.lane.board.toFixed(1);
  $("#resultBreakDistance").textContent = `${motion.breakpoint.lane.feet.toFixed(0)} ft`;
  $("#resultEntryBoard").textContent = motion.entry.lane.board.toFixed(1);
  $("#resultEntryAngle").textContent = motion.entryAngle.toFixed(1);
  $("#resultAimBoard").textContent = motion.aim.lane.board.toFixed(1);
  $("#resultGuideBoard").textContent = motion.guide.lane.board.toFixed(1);
  $("#resultTrackFrames").textContent = motion.line.length;
  $("#resultTrackTime").textContent = `${motion.duration.toFixed(2)}초`;
  $("#resultRpm").textContent = rpm ? `${rpm}` : "—";
  $("#rpmNote").textContent = rpm ? "궤적 곡률 기반 추정치" : "곡률 부족으로 추정 불가";

  const consistency = Number.isFinite(result?.consistency) ? result.consistency : (computeConsistency(state.history)?.score ?? 0);
  drawShotRadarCard({
    speed: result?.speed || motion.speed || 0,
    rpm,
    balance: result?.balance ?? 0,
    entryAngle: motion.entryAngle,
    consistency: consistency ?? 0
  });
}

function drawShotRadarCard(values) {
  const radarCanvas = $("#shotRadarCanvas");
  if (!radarCanvas) return;
  const ctx = radarCanvas.getContext("2d");
  const w = radarCanvas.clientWidth || 260;
  const h = radarCanvas.clientHeight || 220;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  radarCanvas.width = Math.round(w * ratio);
  radarCanvas.height = Math.round(h * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!values) {
    ctx.fillStyle = "rgba(244,247,242,.3)";
    ctx.font = "600 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("샷 분석 후 표시됩니다", w / 2, h / 2);
    return;
  }
  const normSpeed = Math.max(0, Math.min(100, (values.speed || 0) / 32 * 100));
  const normRpm = Math.max(0, Math.min(100, (values.rpm || 0) / 500 * 100));
  const normBalance = Math.max(0, Math.min(100, values.balance || 0));
  const normAngle = Math.max(0, Math.min(100, 100 - Math.abs((values.entryAngle || 0) - 5) * 14));
  const normConsistency = Math.max(0, Math.min(100, values.consistency || 0));
  drawShotRadar(ctx, w / 2, h / 2, Math.min(w, h) / 2 - 26, [normSpeed, normRpm, normBalance, normAngle, normConsistency], {
    fillColor: "rgba(201,255,61,.2)",
    strokeColor: "#c9ff3d"
  });
}

const TRAJECTORY_SEGMENT_COLORS = ["#c9ff3d", "#50d9cd", "#ff7043"];

function computeConsistency(shots) {
  const recent = shots.filter(shot => shot && Number.isFinite(shot.score)).slice(0, 10);
  if (recent.length < 2) return null;
  const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
  const std = values => {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
  };
  const cv = values => {
    const m = mean(values);
    return m > 0 ? std(values) / m : 0;
  };
  const metrics = [];
  const speedValues = recent.map(s => s.speed).filter(v => v > 0);
  if (speedValues.length >= 2) metrics.push(cv(speedValues));
  const releaseValues = recent.map(s => s.release).filter(v => Number.isFinite(v));
  if (releaseValues.length >= 2) metrics.push(cv(releaseValues));
  const balanceValues = recent.map(s => s.balance).filter(v => Number.isFinite(v));
  if (balanceValues.length >= 2) metrics.push(cv(balanceValues));
  const entryValues = recent.map(s => s.ballMotion?.entryAngle).filter(v => Number.isFinite(v));
  if (entryValues.length >= 2) metrics.push(cv(entryValues));
  const breakValues = recent.map(s => s.ballMotion?.breakBoard).filter(v => Number.isFinite(v));
  if (breakValues.length >= 2) metrics.push(cv(breakValues));
  if (!metrics.length) return null;
  const avgCv = mean(metrics);
  const score = Math.round(Math.max(0, Math.min(100, 100 - avgCv * 320)));
  return { score, samples: recent.length, avgCv };
}

function estimateRpm(motion) {
  if (!motion?.valid || !motion.curveRate || motion.duration < .3) return 0;
  const curveRate = motion.curveRate;
  const speed = motion.speed || motion.startSpeed || 25;
  const speedFactor = Math.max(.55, Math.min(1.3, speed / 25));
  const angularSpeed = curveRate * speedFactor;
  let rpm = angularSpeed * 60 / (2 * Math.PI) * 9.5;
  rpm = Math.max(0, Math.min(650, rpm));
  if (motion.entryAngle < .5) rpm = Math.min(rpm, 150);
  return Math.round(rpm / 5) * 5;
}

function computeMyLane(shots) {
  const valid = shots.filter(shot => shot?.ballMotion?.breakBoard && Number.isFinite(shot.ballMotion.breakBoard)).slice(0, 8);
  if (valid.length < 4) return null;
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    breakBoard: median(valid.map(s => s.ballMotion.breakBoard)),
    entryBoard: median(valid.map(s => s.ballMotion.entryBoard)),
    samples: valid.length
  };
}

function drawShotRadar(targetCtx, centerX, centerY, radius, values, options = {}) {
  const labels = options.labels || ["구속", "회전", "밸런스", "진입각", "일관성"];
  const count = labels.length;
  if (values.length !== count) return;
  targetCtx.save();
  targetCtx.translate(centerX, centerY);
  for (let level = 1; level <= 4; level++) {
    const r = radius * level / 4;
    targetCtx.beginPath();
    for (let i = 0; i <= count; i++) {
      const angle = -Math.PI / 2 + (i % count) * 2 * Math.PI / count;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    }
    targetCtx.strokeStyle = level === 4 ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.08)";
    targetCtx.lineWidth = 1;
    targetCtx.stroke();
  }
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
    targetCtx.beginPath();
    targetCtx.moveTo(0, 0);
    targetCtx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    targetCtx.strokeStyle = "rgba(255,255,255,.06)";
    targetCtx.stroke();
  }
  targetCtx.beginPath();
  for (let i = 0; i <= count; i++) {
    const value = values[i % count];
    const r = Math.max(0, Math.min(1, value / 100)) * radius;
    const angle = -Math.PI / 2 + (i % count) * 2 * Math.PI / count;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) targetCtx.moveTo(x, y);
    else targetCtx.lineTo(x, y);
  }
  targetCtx.fillStyle = options.fillColor || "rgba(201,255,61,.22)";
  targetCtx.fill();
  targetCtx.strokeStyle = options.strokeColor || "#c9ff3d";
  targetCtx.lineWidth = 2;
  targetCtx.shadowColor = options.strokeColor || "#c9ff3d";
  targetCtx.shadowBlur = 6;
  targetCtx.stroke();
  targetCtx.shadowBlur = 0;
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    const r = Math.max(0, Math.min(1, value / 100)) * radius;
    const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    targetCtx.fillStyle = "#07110f";
    targetCtx.strokeStyle = options.strokeColor || "#c9ff3d";
    targetCtx.lineWidth = 2;
    targetCtx.beginPath();
    targetCtx.arc(x, y, 3.5, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();
  }
  targetCtx.fillStyle = options.labelColor || "rgba(244,247,242,.78)";
  targetCtx.font = options.labelFont || "600 9px system-ui";
  targetCtx.textAlign = "center";
  targetCtx.textBaseline = "middle";
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
    const labelR = radius + 14;
    targetCtx.fillText(labels[i], Math.cos(angle) * labelR, Math.sin(angle) * labelR);
  }
  targetCtx.restore();
}

function drawSegmentedTrajectory(targetCtx, points, breakIndex, entryIndex, options = {}) {
  const count = points.length;
  if (count < 2) return;
  const { lineWidth = 3, glow = true, dashed = false, markers = true, endBall = false } = options;
  const breakAt = Math.max(0, Math.min(count - 1, breakIndex ?? Math.floor(count * .65)));
  const entryAt = Math.max(breakAt + 1, Math.min(count - 1, entryIndex ?? Math.floor(count * .85)));
  const segmentRanges = [[0, breakAt], [breakAt, entryAt], [entryAt, count - 1]];
  const dashPattern = dashed ? [6, 5] : [];

  targetCtx.save();
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";

  if (glow) {
    targetCtx.shadowBlur = 8;
  }

  segmentRanges.forEach(([start, end], index) => {
    if (end <= start) return;
    const color = TRAJECTORY_SEGMENT_COLORS[index];
    targetCtx.strokeStyle = color;
    targetCtx.lineWidth = lineWidth;
    targetCtx.setLineDash(dashPattern);
    if (glow) targetCtx.shadowColor = color;
    targetCtx.beginPath();
    for (let i = start; i <= end; i++) {
      if (i === start) targetCtx.moveTo(points[i].x, points[i].y);
      else targetCtx.lineTo(points[i].x, points[i].y);
    }
    targetCtx.stroke();
  });

  targetCtx.setLineDash([]);

  if (markers) {
    const markerPoints = [breakAt, entryAt];
    markerPoints.forEach((index, markerIndex) => {
      if (index <= 0 || index >= count - 1) return;
      const point = points[index];
      const color = TRAJECTORY_SEGMENT_COLORS[markerIndex + 1];
      targetCtx.fillStyle = "#07110f";
      targetCtx.strokeStyle = color;
      targetCtx.lineWidth = 2;
      targetCtx.shadowColor = color;
      targetCtx.shadowBlur = 10;
      targetCtx.beginPath();
      targetCtx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.stroke();
    });
  }

  if (endBall) {
    const ball = points[count - 1];
    targetCtx.fillStyle = "#35d6c8";
    targetCtx.strokeStyle = "rgba(255,255,255,.92)";
    targetCtx.lineWidth = 2;
    targetCtx.shadowColor = "#35d6c8";
    targetCtx.shadowBlur = 12;
    targetCtx.beginPath();
    targetCtx.arc(ball.x, ball.y, 8, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();
  }

  targetCtx.shadowBlur = 0;
  targetCtx.restore();
}

function smoothTrajectory(points) {
  if (points.length < 3) return points;
  return points.map((point, index) => {
    const from = Math.max(0, index - 2);
    const to = Math.min(points.length, index + 3);
    const group = points.slice(from, to);
    return {
      x: group.reduce((sum, item) => sum + item.x, 0) / group.length,
      y: group.reduce((sum, item) => sum + item.y, 0) / group.length,
      time: point.time
    };
  });
}

function trackingProfile() {
  return state.captureMode === "action"
    ? {
        trackerWidth: 288,
        scanInterval: 32,
        wristRadius: .22,
        block: 6,
        initialDelay: 40,
        searchRadius: 54,
        recoveryRadius: 78,
        laneMargin: .12,
        minTrackFrames: 6,
        minTravel: .075,
        maxDuration: 5.2
      }
    : {
        trackerWidth: 216,
        scanInterval: 48,
        wristRadius: .17,
        block: 8,
        initialDelay: 80,
        searchRadius: 40,
        recoveryRadius: 58,
        laneMargin: .08,
        minTrackFrames: 7,
        minTravel: .085,
        maxDuration: 4.5
      };
}

function resetBallTracker(timestamp = performance.now(), seed = null) {
  state.ballTracker = {
    startedAt: timestamp,
    releaseAt: 0,
    arrivalAt: 0,
    lastSeenAt: 0,
    previous: seed ? { x: seed.x, y: seed.y } : null,
    detected: false,
    candidateFrames: 0,
    previousLuma: null,
    origin: seed ? { x: seed.x, y: seed.y } : null,
    confirmed: false,
    valid: false,
    missedFrames: 0,
    velocity: { x: 0, y: -2 },
    currentStage: seed?.stage || null,
    released: false,
    seeded: Boolean(seed)
  };
  state.trajectory = [];
  state.showFinalTrajectory = false;
}

function learnBallNearWrist(timestamp, wristPoint) {
  const profile = trackingProfile();
  if (state.shot || video.readyState < 2 || timestamp - state.lastBallScanAt < profile.scanInterval) return;
  state.lastBallScanAt = timestamp;
  const tracker = state.trackerCanvas;
  const tw = profile.trackerWidth;
  const th = Math.round(tw * (video.videoHeight || 1920) / (video.videoWidth || 1080));
  tracker.width = tw;
  tracker.height = th;
  const context = tracker.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, tw, th);
  const pixels = context.getImageData(0, 0, tw, th).data;
  const wrist = stageToTracker(wristPoint, tw, th);
  const radius = tw * profile.wristRadius;
  const block = profile.block;
  let best = null;

  for (let y = Math.max(block, wrist.y - radius); y <= Math.min(th - block, wrist.y + radius); y += 4) {
    for (let x = Math.max(block, wrist.x - radius); x <= Math.min(tw - block, wrist.x + radius); x += 4) {
      const distance = Math.hypot(x - wrist.x, y - wrist.y);
      if (distance < tw * .035 || distance > radius) continue;
      let r = 0, g = 0, b = 0, luminance = 0, samples = 0;
      for (let by = -block / 2; by < block / 2; by += 2) {
        for (let bx = -block / 2; bx < block / 2; bx += 2) {
          const index = (Math.round(y + by) * tw + Math.round(x + bx)) * 4;
          const pr = pixels[index];
          const pg = pixels[index + 1];
          const pb = pixels[index + 2];
          r += pr; g += pg; b += pb;
          luminance += pr * .2126 + pg * .7152 + pb * .0722;
          samples++;
        }
      }
      r /= samples; g /= samples; b /= samples; luminance /= samples;
      const saturation = Math.max(r,g,b) - Math.min(r,g,b);
      const darkScore = Math.max(0, 175 - luminance);
      const colorScore = saturation * .45;
      const positionScore = Math.max(0, 24 - Math.abs(distance - tw * .085));
      const lowerHandBonus = y >= wrist.y - 4 ? 15 : 0;
      const score = darkScore + colorScore + positionScore + lowerHandBonus;
      if (!best || score > best.score) best = { x, y, r, g, b, score };
    }
  }
  if (!best || best.score < 48) return;
  const stagePoint = sourceToStage(best.x, best.y, tw, th);
  const previous = state.autoBallLock;
  const stable = previous
    && Math.hypot(best.x - previous.x, best.y - previous.y) < tw * .10
    && timestamp - previous.time < 500;
  const stableFrames = stable ? previous.stableFrames + 1 : 1;
  state.autoBallLock = {
    ...best,
    stage: stagePoint,
    time: timestamp,
    stableFrames,
    color: {
      r: stable ? previous.color.r * .7 + best.r * .3 : best.r,
      g: stable ? previous.color.g * .7 + best.g * .3 : best.g,
      b: stable ? previous.color.b * .7 + best.b * .3 : best.b
    }
  };
  if (!state.ballColor && stableFrames >= 3) {
    $("#modelStatus").innerHTML = "LIVE · <b>BALL READY</b>";
  }
}

function sourceToStage(x, y, sourceW, sourceH) {
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const scale = Math.max(stageW / sourceW, stageH / sourceH);
  return {
    x: x * scale - (sourceW * scale - stageW) / 2,
    y: y * scale - (sourceH * scale - stageH) / 2
  };
}

function stageToTracker(point, trackerW, trackerH) {
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const sourceW = video.videoWidth || trackerW;
  const sourceH = video.videoHeight || trackerH;
  const scale = Math.max(stageW / sourceW, stageH / sourceH);
  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  const sourceX = (point.x + (renderedW - stageW) / 2) / scale;
  const sourceY = (point.y + (renderedH - stageH) / 2) / scale;
  return { x: sourceX / sourceW * trackerW, y: sourceY / sourceH * trackerH };
}

function detectBall(timestamp, wristPoint, posePoints) {
  if (!state.shot || !state.ballTracker || video.readyState < 2) return;
  const profile = trackingProfile();
  if (timestamp - state.ballTracker.startedAt < (state.ballTracker.seeded ? profile.initialDelay : 220)) return;
  if (timestamp - state.lastBallScanAt < profile.scanInterval) return;
  state.lastBallScanAt = timestamp;
  const tracker = state.trackerCanvas;
  const tw = profile.trackerWidth;
  const th = Math.round(tw * (video.videoHeight || 1920) / (video.videoWidth || 1080));
  tracker.width = tw;
  tracker.height = th;
  const tctx = tracker.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(video, 0, 0, tw, th);
  const image = tctx.getImageData(0, 0, tw, th);
  const luma = new Uint8Array(tw * th);
  for (let index = 0, pixel = 0; index < image.data.length; index += 4, pixel++) {
    luma[pixel] = Math.round(image.data[index] * .2126 + image.data[index + 1] * .7152 + image.data[index + 2] * .0722);
  }

  const previous = state.ballTracker.previous;
  const previousLuma = state.ballTracker.previousLuma;
  const trackingColor = state.ballColor || state.autoBallLock?.color || null;
  const wristSource = stageToTracker(wristPoint, tw, th);
  const excludedPose = [0, 7, 8, 11, 12, 23, 24]
    .map(index => posePoints[index])
    .filter(point => point?.visibility > .35)
    .map(point => stageToTracker(point, tw, th));
  const minY = Math.round(th * .23);
  const maxY = Math.round(th * (previous ? Math.min(.78, previous.y / th + .13) : .78));
  const minX = Math.round(tw * .18);
  const maxX = Math.round(tw * .82);
  let best = null;
  const block = 6;

  for (let y = minY; y < maxY; y += block) {
    for (let x = minX; x < maxX; x += block) {
      let dark = 0;
      let moving = 0;
      let total = 0;
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;
      for (let by = 0; by < block && y + by < th; by += 2) {
        for (let bx = 0; bx < block && x + bx < tw; bx += 2) {
          const pixelIndex = (y + by) * tw + x + bx;
          const index = pixelIndex * 4;
          const r = image.data[index];
          const g = image.data[index + 1];
          const b = image.data[index + 2];
          redTotal += r;
          greenTotal += g;
          blueTotal += b;
          const luminance = luma[pixelIndex];
          if (luminance < 108) dark++;
          if (previousLuma && Math.abs(luminance - previousLuma[pixelIndex]) > 16) moving++;
          total++;
        }
      }
      if (!trackingColor && dark < Math.max(2, total * .24)) continue;
      if (previousLuma && moving < Math.max(1, total * (state.ballTracker.released ? .10 : .15))) continue;
      const averageColor = { r: redTotal / total, g: greenTotal / total, b: blueTotal / total };
      const colorDistance = trackingColor
        ? Math.hypot(
            averageColor.r - trackingColor.r,
            averageColor.g - trackingColor.g,
            averageColor.b - trackingColor.b
          )
        : 0;
      if (trackingColor && !state.ballTracker.released && colorDistance > 145) continue;
      if (trackingColor && state.ballTracker.released && colorDistance > 190) continue;
      const cx = x + block / 2;
      const cy = y + block / 2;
      const wristDistance = Math.hypot(cx - wristSource.x, cy - wristSource.y);
      const nearBody = excludedPose.some((point, index) => {
        const radius = index < 3 ? tw * .095 : tw * .07;
        return Math.hypot(cx - point.x, cy - point.y) < radius;
      });
      if (nearBody && wristDistance > tw * .15) continue;
      let score = dark * 4 + moving * 5;
      if (trackingColor) score += Math.max(0, 160 - colorDistance) * (state.ballTracker.released ? .28 : .55);
      if (previous) {
        const predictedX = previous.x + state.ballTracker.velocity.x;
        const predictedY = previous.y + state.ballTracker.velocity.y;
        const predictionDistance = Math.hypot(cx - predictedX, cy - predictedY);
        const distance = Math.hypot(cx - previous.x, cy - previous.y);
        const recoveryRadius = state.ballTracker.missedFrames ? profile.recoveryRadius : profile.searchRadius;
        if (predictionDistance > recoveryRadius * 1.25 || distance > 88 || cy > previous.y + 16) continue;
        if (state.ballTracker.candidateFrames > 3 && cy >= previous.y + 1) continue;
        if (state.ballTracker.origin) {
          const previousTravel = Math.hypot(previous.x - state.ballTracker.origin.x, previous.y - state.ballTracker.origin.y);
          const nextTravel = Math.hypot(cx - state.ballTracker.origin.x, cy - state.ballTracker.origin.y);
          if (state.ballTracker.candidateFrames > 3 && nextTravel + 2 < previousTravel) continue;
          score += Math.max(0, nextTravel - previousTravel) * 4;
        }
        score += Math.max(0, 62 - predictionDistance) * 2.4;
        score += Math.max(0, 45 - distance);
        score += Math.max(0, previous.y - cy) * .8;
      } else {
        if (wristDistance > tw * .18 || cy < wristSource.y - th * .07) continue;
        score += Math.max(0, tw * .20 - wristDistance) * 2;
      }
      if (!best || score > best.score) best = { x: cx, y: cy, score };
    }
  }

  if (!best) {
    state.ballTracker.previousLuma = luma;
    if (!state.ballTracker.confirmed) {
      state.ballTracker.candidateFrames = Math.max(0, state.ballTracker.candidateFrames - 1);
    }
    state.ballTracker.missedFrames++;
    if (
      state.ballTracker.released &&
      state.ballTracker.previous &&
      state.ballTracker.missedFrames <= 3
    ) {
      const predicted = {
        x: state.ballTracker.previous.x + state.ballTracker.velocity.x,
        y: state.ballTracker.previous.y + state.ballTracker.velocity.y
      };
      const predictedStage = sourceToStage(predicted.x, predicted.y, tw, th);
      if (isInsideLane(predictedStage, stage.clientWidth * profile.laneMargin)) {
        state.trajectory.push({ ...predictedStage, time: timestamp, predicted: true });
        state.trajectory = state.trajectory.slice(-90);
        state.ballTracker.previous = predicted;
      }
    }
    if (
      state.ballTracker.confirmed &&
      !state.ballTracker.arrivalAt &&
      state.ballTracker.missedFrames >= 4 &&
      state.ballTracker.previous?.y < th * .48
    ) {
      state.ballTracker.arrivalAt = state.ballTracker.lastSeenAt;
    }
    if (!state.ballTracker.confirmed && state.ballTracker.missedFrames > 5) {
      state.ballTracker.previous = null;
      state.ballTracker.origin = null;
      state.trajectory = [];
    }
    return;
  }

  const stagePoint = sourceToStage(best.x, best.y, tw, th);
  if (!isInsideLane(stagePoint, stage.clientWidth * profile.laneMargin)) {
    state.ballTracker.previousLuma = luma;
    state.ballTracker.missedFrames++;
    return;
  }
  const oldPrevious = state.ballTracker.previous;
  state.ballTracker.missedFrames = 0;
  state.ballTracker.candidateFrames++;
  state.ballTracker.previous = best;
  if (oldPrevious) {
    const measuredVelocity = { x: best.x - oldPrevious.x, y: best.y - oldPrevious.y };
    state.ballTracker.velocity = {
      x: state.ballTracker.velocity.x * .55 + measuredVelocity.x * .45,
      y: state.ballTracker.velocity.y * .55 + measuredVelocity.y * .45
    };
  }
  if (!state.ballTracker.origin) state.ballTracker.origin = { x: best.x, y: best.y };
  state.ballTracker.previousLuma = luma;
  state.ballTracker.lastSeenAt = timestamp;
  if (state.ballTracker.candidateFrames < 2) return;
  state.ballTracker.detected = true;
  const wristTrackerPoint = stageToTracker(wristPoint, tw, th);
  const separation = Math.hypot(best.x - wristTrackerPoint.x, best.y - wristTrackerPoint.y);
  if (!state.ballTracker.released && separation > tw * .075 && best.y < wristTrackerPoint.y + th * .04) {
    state.ballTracker.released = true;
    state.ballTracker.releaseAt = timestamp;
    state.ballTracker.origin = { x: best.x, y: best.y };
    state.trajectory = [];
  }
  if (!state.ballTracker.released) {
    state.ballTracker.currentStage = stagePoint;
    $("#modelStatus").innerHTML = "LIVE · <b>BALL LOCKED</b>";
    return;
  }
  state.trajectory.push({ ...stagePoint, time: timestamp });
  state.ballTracker.currentStage = stagePoint;
  state.trajectory = state.trajectory.slice(-90);
  const trackerTravel = Math.hypot(best.x - state.ballTracker.origin.x, best.y - state.ballTracker.origin.y);
  if (state.trajectory.length >= 8 && trackerTravel > 18) {
    const validation = validateTrajectory(state.trajectory);
    state.ballTracker.confirmed = validation.forwardRatio >= .6 && validation.laneRatio >= .55;
  }
  $("#modelStatus").innerHTML = "LIVE · <b>BALL TRACKING</b>";
  if (state.ballTracker.confirmed && best.y < th * .41) state.ballTracker.arrivalAt = timestamp;
}

function createPoseSummary(timestamp) {
  return {
    startedAt: timestamp,
    lastMotionAt: timestamp,
    frames: 0,
    maxWristSpeed: 0,
    minKneeAngle: 180,
    minLeftKneeAngle: 180,
    minRightKneeAngle: 180,
    releaseAngle: 0,
    trunkTilts: [],
    shoulderTilts: [],
    headCenters: [],
    hipCenters: [],
    finishSamples: [],
    slideSpeeds: [],
    previousSlideAnkle: null,
    maxWristAt: timestamp,
    releaseDistanceCm: 0
  };
}

function updatePoseSummary(summary, data) {
  summary.frames++;
  summary.lastMotionAt = data.timestamp;
  if (data.velocity >= summary.maxWristSpeed) {
    summary.maxWristSpeed = data.velocity;
    summary.maxWristAt = data.timestamp;
    const shoulderWidth = Math.max(1, Math.hypot(
      data.rightShoulder.x - data.leftShoulder.x,
      data.rightShoulder.y - data.leftShoulder.y
    ));
    summary.releaseDistanceCm = Math.max(0, Math.min(120,
      Math.hypot(data.wrist.x - data.slideAnkle.x, data.wrist.y - data.slideAnkle.y) / shoulderWidth * 40
    ));
  }
  summary.minKneeAngle = Math.min(summary.minKneeAngle, angleAt(data.hip, data.knee, data.ankle));
  if ([data.leftHip,data.leftKnee,data.leftAnkle].every(point => point.visibility > .58)) {
    summary.minLeftKneeAngle = Math.min(summary.minLeftKneeAngle, angleAt(data.leftHip, data.leftKnee, data.leftAnkle));
  }
  if ([data.rightHip,data.rightKnee,data.rightAnkle].every(point => point.visibility > .58)) {
    summary.minRightKneeAngle = Math.min(summary.minRightKneeAngle, angleAt(data.rightHip, data.rightKnee, data.rightAnkle));
  }
  summary.releaseAngle = Math.atan2(
    Math.abs(data.wrist.y - data.elbow.y),
    Math.abs(data.wrist.x - data.elbow.x)
  ) * 180 / Math.PI;
  summary.trunkTilts.push(Math.atan2(
    Math.abs(data.shoulder.x - data.hip.x),
    Math.abs(data.shoulder.y - data.hip.y)
  ) * 180 / Math.PI);
  if ([data.leftShoulder,data.rightShoulder].every(point => point.visibility > .62)) {
    summary.shoulderTilts.push(Math.abs(Math.atan2(
      data.rightShoulder.y - data.leftShoulder.y,
      data.rightShoulder.x - data.leftShoulder.x
    ) * 180 / Math.PI));
  }
  if (data.head.visibility > .62) {
    summary.headCenters.push({ x: data.head.x / stage.clientWidth, y: data.head.y / stage.clientHeight });
  }
  if ([data.leftHip,data.rightHip].every(point => point.visibility > .62)) {
    summary.hipCenters.push({
      x: (data.leftHip.x + data.rightHip.x) / 2 / stage.clientWidth,
      y: (data.leftHip.y + data.rightHip.y) / 2 / stage.clientHeight
    });
  }
  const normalizedSlide = {
    x: data.slideAnkle.x / stage.clientWidth,
    y: data.slideAnkle.y / stage.clientHeight,
    time: data.timestamp
  };
  if (summary.previousSlideAnkle) {
    const slideDt = Math.max(.016, (data.timestamp - summary.previousSlideAnkle.time) / 1000);
    summary.slideSpeeds.push({
      time: data.timestamp,
      speed: Math.min(2, Math.hypot(
        normalizedSlide.x - summary.previousSlideAnkle.x,
        normalizedSlide.y - summary.previousSlideAnkle.y
      ) / slideDt)
    });
  }
  summary.previousSlideAnkle = normalizedSlide;
  if (data.velocity < .22) summary.finishSamples.push(data.velocity);
}

function beginShot(timestamp) {
  if (timestamp - state.lastShotFinishedAt < 3500) return;
  const autoSeed = state.autoBallLock?.stableFrames >= 3 && timestamp - state.autoBallLock.time < 700
    ? state.autoBallLock
    : null;
  state.shot = createPoseSummary(timestamp);
  resetBallTracker(timestamp, autoSeed);
  stage.classList.add("live-tracking");
  setFlow("pose");
  $(".feedback-float").classList.add("visible");
  $(".feedback-float b").textContent = "투구 동작을 감지했어요";
  $(".feedback-float small").textContent = "피니시 자세까지 계속 촬영합니다";
}

function finishLiveShot() {
  const shot = state.shot;
  if (!shot) return;
  const maxSpeed = Math.max(.15, shot.maxWristSpeed);
  const trajectoryValidation = validateTrajectory(state.trajectory);
  state.ballTracker.valid = trajectoryValidation.valid;
  state.showFinalTrajectory = trajectoryValidation.valid;
  const releaseAt = trajectoryValidation.valid ? state.ballTracker?.releaseAt || 0 : 0;
  const arrivalAt = state.ballTracker?.arrivalAt || 0;
  const travelSeconds = releaseAt && arrivalAt > releaseAt ? (arrivalAt - releaseAt) / 1000 : 0;
  const firstTrackPoint = state.trajectory[0];
  const lastTrackPoint = state.trajectory[state.trajectory.length - 1];
  const laneBounds = firstTrackPoint ? laneBoundsAtStageY(firstTrackPoint.y) : null;
  const visibleLaneHeight = laneBounds ? laneBounds.bottomY - laneBounds.topY : 0;
  const traveledFraction = visibleLaneHeight && lastTrackPoint
    ? Math.max(.35, Math.min(1, (firstTrackPoint.y - lastTrackPoint.y) / visibleLaneHeight))
    : 0;
  const trackedDistance = 18.29 * traveledFraction;
  const trackedSpeed = trajectoryValidation.valid && travelSeconds > .55 && travelSeconds < 4.5
    ? trackedDistance / travelSeconds * 3.6
    : 0;
  const speed = trackedSpeed && trackedSpeed <= 40 ? trackedSpeed : 0;
  const ballMotion = analyzeShotTrajectory(state.trajectory, speed);
  const release = Math.min(28, Math.max(8, shot.releaseAngle || 16));
  const rightHanded = $("#handedness").value !== "왼손";
  const slideSide = rightHanded ? "L" : "R";
  const slideKneeAngle = rightHanded ? shot.minLeftKneeAngle : shot.minRightKneeAngle;
  const supportKneeAngle = rightHanded ? shot.minRightKneeAngle : shot.minLeftKneeAngle;
  const kneeQuality = Math.max(0, 100 - Math.abs((shot.minKneeAngle || 145) - 138) * 1.2);
  const avgTilt = shot.trunkTilts.length ? shot.trunkTilts.reduce((a,b) => a + b, 0) / shot.trunkTilts.length : 12;
  const tiltQuality = Math.max(0, 100 - Math.abs(avgTilt - 12) * 2.2);
  const finishMovement = shot.finishSamples.length ? shot.finishSamples.reduce((a,b) => a + b, 0) / shot.finishSamples.length : .04;
  const balance = Math.round(Math.max(55, Math.min(98, 98 - finishMovement * 220)));
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const deviation = values => {
    if (values.length < 2) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map(value => (value - mean) ** 2)));
  };
  const shoulderTilt = average(shot.shoulderTilts);
  const headSway = deviation(shot.headCenters.map(point => point.x));
  const hipSway = deviation(shot.hipCenters.map(point => point.x));
  const releaseBalance = Math.round(Math.max(45, Math.min(99, 98 - (headSway * 420 + hipSway * 260))));
  const releaseWindow = shot.slideSpeeds.filter(sample => Math.abs(sample.time - shot.maxWristAt) <= 650);
  const slideStop = releaseWindow.length
    ? releaseWindow.reduce((best, sample) => sample.speed < best.speed ? sample : best, releaseWindow[0])
    : null;
  const releaseTimingMs = slideStop ? Math.round(shot.maxWristAt - slideStop.time) : 0;
  const rhythmSpread = deviation(shot.slideSpeeds.map(sample => sample.speed));
  const stepRhythm = shot.slideSpeeds.length < 8 ? "영상 부족" : rhythmSpread < .12 ? "안정적" : rhythmSpread < .24 ? "보통" : "개선 필요";
  const score = Math.round(Math.max(55, Math.min(98, kneeQuality * .25 + tiltQuality * .25 + balance * .35 + Math.min(100, maxSpeed * 75) * .15)));

  let feedback;
  if (shot.minKneeAngle > 158) {
    feedback = ["슬라이드 무릎을 더 사용해보세요.", `현재 최소 무릎각은 약 ${Math.round(shot.minKneeAngle)}°예요. 피니시에서 중심을 8–12cm 낮춰보세요.`];
  } else if (avgTilt > 24) {
    feedback = ["상체가 앞으로 많이 기울었어요.", `상체 기울기가 약 ${Math.round(avgTilt)}°예요. 가슴을 조금 더 세우고 머리를 무릎 위에 유지하세요.`];
  } else if (balance < 78) {
    feedback = ["피니시를 1초 더 유지해보세요.", "릴리스 뒤 몸의 흔들림이 감지됐어요. 슬라이드 발 위에 머리를 남겨보세요."];
  } else {
    feedback = ["안정적인 피니시예요.", "스윙과 슬라이드 타이밍이 잘 맞았습니다. 같은 시작 템포를 반복해보세요."];
  }

  const rpm = estimateRpm(ballMotion);
  const consistency = computeConsistency(state.history);
  const result = {
    score,
    speed: speed || 0,
    release,
    board: 7 + Math.min(4, state.trajectory.length / 12),
    balance,
    rpm,
    consistency: consistency?.score ?? null,
    postureAnalysis: {
      handedness: rightHanded ? "오른손" : "왼손",
      slideSide,
      slideKneeAngle: Number.isFinite(slideKneeAngle) ? slideKneeAngle : 0,
      supportKneeAngle: Number.isFinite(supportKneeAngle) ? supportKneeAngle : 0,
      releaseTimingMs,
      personalNumberCm: shot.releaseDistanceCm,
      releaseBalance,
      shoulderTilt,
      stepRhythm,
      rhythmSpread
    },
    feedback,
    ballMotion: ballMotion.valid ? {
      breakBoard: ballMotion.breakpoint.lane.board,
      breakFeet: ballMotion.breakpoint.lane.feet,
      entryBoard: ballMotion.entry.lane.board,
      entryAngle: ballMotion.entryAngle,
      frames: ballMotion.line.length,
      duration: ballMotion.duration
    } : null
  };
  setMetrics(result);
  drawShotResult(ballMotion, result);
  saveShot(result);
  setFlow("result");
  $(".feedback-float b").textContent = feedback[0];
  $(".feedback-float small").textContent = `${score}점 · ${speed ? `${speed.toFixed(1)}km/h` : "속도 측정 실패"} · 무릎 ${Math.round(shot.minKneeAngle)}°`;
  state.shot = null;
  state.prevWrist = null;
  state.ballTracker = null;
  state.trajectory = [];
  state.showFinalTrajectory = false;
  state.smoothedPose = null;
  state.poseHistory = [];
  state.autoBallLock = null;
  state.lastShotFinishedAt = performance.now();
  state.videoAnalysisCompleted = true;
  stage.classList.remove("live-tracking");
  setTimeout(() => {
    $(".feedback-float").classList.remove("visible");
  }, 2500);
  if (state.sound) speak(feedback.join(" "));
  showToast(`실시간 샷 분석 완료 · ${score}점`);
  runAnalysisProgress();
}

function analyzePose(points, timestamp) {
  if (state.poseConfidence < .58) return;
  const rightHanded = $("#handedness").value !== "왼손";
  const shoulder = points[rightHanded ? 12 : 11];
  const elbow = points[rightHanded ? 14 : 13];
  const wrist = points[rightHanded ? 16 : 15];
  const hip = points[rightHanded ? 24 : 23];
  const knee = points[rightHanded ? 26 : 25];
  const ankle = points[rightHanded ? 28 : 27];
  if ([shoulder, elbow, wrist, hip, knee, ankle].some(p => p.visibility < .58)) return;
  const leftShoulder = points[11];
  const rightShoulder = points[12];
  const leftHip = points[23];
  const rightHip = points[24];
  const leftKnee = points[25];
  const rightKnee = points[26];
  const leftAnkle = points[27];
  const rightAnkle = points[28];
  const head = points[0];
  const slideAnkle = rightHanded ? leftAnkle : rightAnkle;
  if (state.fileVideo && !state.videoPoseSummary) {
    state.videoPoseSummary = createPoseSummary(timestamp);
  }

  if (!state.shot) learnBallNearWrist(timestamp, wrist);
  const normalizedWrist = { x: wrist.x / stage.clientWidth, y: wrist.y / stage.clientHeight, time: timestamp };
  if (state.prevWrist) {
    const dt = Math.max(.016, (timestamp - state.prevWrist.time) / 1000);
    const velocity = Math.hypot(normalizedWrist.x - state.prevWrist.x, normalizedWrist.y - state.prevWrist.y) / dt;
    if (state.fileVideo && state.videoPoseSummary) {
      updatePoseSummary(state.videoPoseSummary, {
        timestamp, velocity, wrist, elbow, shoulder, hip, knee, ankle,
        leftShoulder, rightShoulder, leftHip, rightHip,
        leftKnee, rightKnee, leftAnkle, rightAnkle,
        head, slideAnkle
      });
    }

    const shotThreshold = state.fileVideo ? .27 : .34;
    if (!state.shot && velocity > shotThreshold) beginShot(timestamp);
    if (state.shot) {
      if (velocity >= state.shot.maxWristSpeed) {
        state.shot.maxWristSpeed = velocity;
        state.shot.maxWristAt = timestamp;
        const shoulderWidth = Math.max(1, Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y));
        state.shot.releaseDistanceCm = Math.max(0, Math.min(120, Math.hypot(wrist.x - slideAnkle.x, wrist.y - slideAnkle.y) / shoulderWidth * 40));
      }
      state.shot.minKneeAngle = Math.min(state.shot.minKneeAngle, angleAt(hip, knee, ankle));
      if ([leftHip,leftKnee,leftAnkle].every(point => point.visibility > .58)) {
        state.shot.minLeftKneeAngle = Math.min(state.shot.minLeftKneeAngle, angleAt(leftHip, leftKnee, leftAnkle));
      }
      if ([rightHip,rightKnee,rightAnkle].every(point => point.visibility > .58)) {
        state.shot.minRightKneeAngle = Math.min(state.shot.minRightKneeAngle, angleAt(rightHip, rightKnee, rightAnkle));
      }
      state.shot.releaseAngle = Math.atan2(Math.abs(wrist.y - elbow.y), Math.abs(wrist.x - elbow.x)) * 180 / Math.PI;
      const trunkAngle = Math.atan2(Math.abs(shoulder.x - hip.x), Math.abs(shoulder.y - hip.y)) * 180 / Math.PI;
      state.shot.trunkTilts.push(trunkAngle);
      if ([leftShoulder,rightShoulder].every(point => point.visibility > .62)) {
        state.shot.shoulderTilts.push(Math.abs(Math.atan2(rightShoulder.y - leftShoulder.y, rightShoulder.x - leftShoulder.x) * 180 / Math.PI));
      }
      if (head.visibility > .62) state.shot.headCenters.push({ x: head.x / stage.clientWidth, y: head.y / stage.clientHeight });
      if ([leftHip,rightHip].every(point => point.visibility > .62)) {
        state.shot.hipCenters.push({ x: (leftHip.x + rightHip.x) / 2 / stage.clientWidth, y: (leftHip.y + rightHip.y) / 2 / stage.clientHeight });
      }
      if (slideAnkle.visibility > .58) {
        const normalizedSlide = { x: slideAnkle.x / stage.clientWidth, y: slideAnkle.y / stage.clientHeight, time: timestamp };
        if (state.shot.previousSlideAnkle) {
          const slideDt = Math.max(.016, (timestamp - state.shot.previousSlideAnkle.time) / 1000);
          const slideSpeed = Math.hypot(normalizedSlide.x - state.shot.previousSlideAnkle.x, normalizedSlide.y - state.shot.previousSlideAnkle.y) / slideDt;
          state.shot.slideSpeeds.push({ time: timestamp, speed: Math.min(2, slideSpeed) });
        }
        state.shot.previousSlideAnkle = normalizedSlide;
      }
      if (velocity > .18) state.shot.lastMotionAt = timestamp;
      detectBall(timestamp, wrist, points);
      if (timestamp - state.shot.startedAt > 1200 && velocity < .22) state.shot.finishSamples.push(velocity);
      const shotElapsed = timestamp - state.shot.startedAt;
      const bodyFinished = shotElapsed > 2200 && timestamp - state.shot.lastMotionAt > 900;
      const ballFinished = Boolean(state.ballTracker?.arrivalAt);
      const trackingWindowOpen = state.ballTracker?.confirmed && shotElapsed < 5800;
      if (bodyFinished && (ballFinished || !trackingWindowOpen)) finishLiveShot();
      if (shotElapsed > 6200) finishLiveShot();
    }
  }
  state.prevWrist = normalizedWrist;
}

async function liveLoop(timestamp = performance.now()) {
  if (!state.running) return;
  if (state.fileVideo && video.paused) {
    $("#modelStatus").textContent = "영상 일시정지";
    state.animationId = null;
    return;
  }
  state.frame++;
  if (!state.poseBusy && video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.poseBusy = true;
    state.lastVideoTime = video.currentTime;
    try {
      if (state.modelReady && window.LanePose) {
        const result = await window.LanePose.detect(video, timestamp);
        if (result.landmarks?.[0]) {
          const points = drawPose(result.landmarks[0]);
          analyzePose(points, timestamp);
          if (!state.shot) setFlow("pose");
          if (state.ballTracker?.released) {
            $("#modelStatus").innerHTML = "LIVE · <b>BALL TRACKING</b>";
          } else if (state.ballTracker?.detected) {
            $("#modelStatus").innerHTML = "LIVE · <b>BALL LOCKED</b>";
          } else if (state.autoBallLock?.stableFrames >= 3) {
            $("#modelStatus").innerHTML = "LIVE · <b>BALL READY</b>";
          } else {
            $("#modelStatus").innerHTML = "LIVE · <b>POSE</b>";
          }
        } else {
          drawGuide(0, true);
          $("#modelStatus").textContent = "전신을 화면에 맞춰주세요";
        }
      } else {
        drawGuide(0, true);
      }
    } catch (error) {
      console.warn("Pose frame failed", error);
    } finally {
      state.poseBusy = false;
    }
  }
  state.animationId = requestAnimationFrame(liveLoop);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("이 브라우저는 카메라 촬영을 지원하지 않아요.");
    return;
  }
  try {
    const actionMode = state.captureMode === "action";
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: actionMode ? 1920 : 1280 },
        height: { ideal: actionMode ? 1080 : 720 },
        frameRate: { ideal: 60, min: actionMode ? 30 : 24 }
      },
      audio: false
    });
    video.srcObject = state.stream;
    video.removeAttribute("src");
    await video.play();
    state.running = true;
    state.fileVideo = false;
    state.prevWrist = null;
    state.shot = null;
    state.trajectory = [];
    state.ballTracker = null;
    state.showFinalTrajectory = false;
    state.smoothedPose = null;
    state.poseHistory = [];
    state.autoBallLock = null;
    $("#videoPlaybackControls").hidden = true;
    stage.classList.remove("file-video");
    cameraButton.classList.add("active");
    video.classList.add("visible");
    placeholder.classList.add("hidden");
    stage.classList.add("analyzing");
    $(".live-badge").innerHTML = "<span></span> 분석 중";
    setFlow("camera");
    cancelAnimationFrame(state.animationId);
    liveLoop();
    showToast("카메라 분석을 시작했어요.");
  } catch (error) {
    showToast(error.name === "NotAllowedError" ? "카메라 권한을 허용해주세요." : "카메라를 시작할 수 없어요.");
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  state.running = false;
  state.shot = null;
  state.prevWrist = null;
  state.trajectory = [];
  state.ballTracker = null;
  state.showFinalTrajectory = false;
  state.smoothedPose = null;
  state.poseHistory = [];
  state.autoBallLock = null;
  cancelAnimationFrame(state.animationId);
  cameraButton.classList.remove("active");
  stage.classList.remove("analyzing");
  video.classList.remove("visible");
  placeholder.classList.remove("hidden");
  video.srcObject = null;
  if (state.fileVideo) {
    video.pause();
    URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
    video.load();
  }
  state.fileVideo = false;
  $("#videoPlaybackControls").hidden = true;
  stage.classList.remove("file-video");
  $(".live-badge").innerHTML = "<span></span> 준비됨";
  setFlow("camera");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  showToast("세션을 저장했어요.");
}

cameraButton.addEventListener("click", () => state.running ? stopCamera() : startCamera());

$("#flipButton").addEventListener("click", async () => {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  if (state.running) {
    stopCamera();
    await startCamera();
  } else {
    showToast(state.facingMode === "user" ? "전면 카메라로 설정했어요." : "후면 카메라로 설정했어요.");
  }
});

$("#videoUpload").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  stopCamera();
  const objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  video.loop = false;
  video.controls = false;
  state.fileVideo = true;
  $("#videoPlaybackControls").hidden = false;
  stage.classList.add("file-video");
  video.play();
  video.classList.add("visible");
  placeholder.classList.add("hidden");
  state.running = true;
  resetAnalysisForSeek();
  stage.classList.add("analyzing");
  cameraButton.classList.add("active");
  liveLoop();
  updateVideoPlaybackUI();
  showToast("영상을 불러왔어요. 아래 버튼으로 정지할 수 있습니다.");
});

function setMetrics(result) {
  $("#shotScore").textContent = result.score;
  $("#speedValue").textContent = result.speed ? result.speed.toFixed(1) : "—";
  $("#releaseValue").textContent = result.release.toFixed(1);
  $("#boardValue").textContent = result.board.toFixed(1);
  $("#balanceValue").textContent = result.balance;
  $(".balance-bar i").style.width = `${result.balance}%`;
  const consistencyValue = result.consistency ?? computeConsistency(state.history)?.score;
  $("#consistencyValue").textContent = Number.isFinite(consistencyValue) ? consistencyValue : "—";
  $("#consistencyBar").style.width = `${Number.isFinite(consistencyValue) ? consistencyValue : 0}%`;
  $("#consistencyMetricNote").textContent = Number.isFinite(consistencyValue)
    ? (consistencyValue >= 80 ? "안정적인 반복" : consistencyValue >= 60 ? "보통 수준" : "변동이 큼")
    : "샷 2개 이상부터 측정";
  $("#rpmValue").textContent = result.rpm ? result.rpm : "—";
  $("#coachTitle").textContent = result.feedback[0];
  $("#coachText").textContent = result.feedback[1];
  if (result.postureAnalysis) updatePostureAnalysis(result.postureAnalysis);
  setFlow("coach");
}

function resetShotReport() {
  $("#shotScore").textContent = "—";
  $("#speedValue").textContent = "—";
  $("#releaseValue").textContent = "—";
  $("#boardValue").textContent = "—";
  $("#balanceValue").textContent = "—";
  $(".balance-bar i").style.width = "0%";
  $("#consistencyValue").textContent = "—";
  $("#rpmValue").textContent = "—";
  $("#coachTitle").textContent = "첫 투구를 기다리고 있어요.";
  $("#coachText").textContent = "카메라를 켜거나 휴대폰 영상을 불러오면 샷 리포트가 여기에 표시됩니다.";
  $("#poseTrackingSide").textContent = `${$("#handedness").value} 기준`;
  const defaults = {
    stepRhythmValue: "분석 대기",
    releaseTimingValue: "— ms",
    slideKneeValue: "—°",
    personalNumberValue: "— cm",
    releaseBalanceValue: "—%",
    shoulderTiltValue: "—°"
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const element = $(`#${id}`);
    element.textContent = value;
    const card = element.closest("article");
    card.dataset.poseStatus = "waiting";
    card.querySelector("i").textContent = "·";
  });
  $("#stepRhythmNote").textContent = "발목 이동 구간";
  $("#releaseTimingNote").textContent = "슬라이딩 정지 대비";
  $("#slideKneeNote").textContent = "L/R 개별 관절 측정";
  $("#releaseBalanceNote").textContent = "머리·상체 중심 흔들림";
  $("#shoulderTiltNote").textContent = "좌우 어깨선 기준";
}

function setPoseMetric(id, value, status, symbol) {
  const element = $(`#${id}`);
  element.textContent = value;
  const card = element.closest("article");
  card.dataset.poseStatus = status;
  card.querySelector("i").textContent = symbol;
}

function updatePostureAnalysis(analysis) {
  $("#poseTrackingSide").textContent = `${analysis.handedness} · 슬라이드 ${analysis.slideSide}`;
  setPoseMetric(
    "stepRhythmValue",
    analysis.stepRhythm,
    analysis.stepRhythm === "안정적" ? "good" : analysis.stepRhythm === "보통" ? "watch" : "warn",
    analysis.stepRhythm === "안정적" ? "✓" : analysis.stepRhythm === "보통" ? "!" : "×"
  );
  $("#stepRhythmNote").textContent = analysis.stepRhythm === "영상 부족" ? "양쪽 발목이 보이는 영상이 필요해요" : "슬라이드 발 속도 변화 기준";

  const timing = analysis.releaseTimingMs;
  const timingGood = Math.abs(timing) <= 120;
  setPoseMetric("releaseTimingValue", `${timing > 0 ? "+" : ""}${timing} ms`, timingGood ? "good" : "watch", timingGood ? "✓" : "!");
  $("#releaseTimingNote").textContent = timing < 0 ? "슬라이딩 정지보다 빠른 릴리스" : timing > 0 ? "슬라이딩 정지 후 릴리스" : "동시점";

  const knee = analysis.slideKneeAngle;
  const kneeGood = knee >= 85 && knee <= 150;
  setPoseMetric("slideKneeValue", knee && knee < 179 ? `${knee.toFixed(0)}°` : "측정 부족", kneeGood ? "good" : "watch", kneeGood ? "✓" : "!");
  $("#slideKneeNote").textContent = `${analysis.slideSide} 슬라이드 · 반대쪽 ${analysis.supportKneeAngle < 179 ? analysis.supportKneeAngle.toFixed(0) + "°" : "미확정"}`;

  const personal = analysis.personalNumberCm;
  setPoseMetric("personalNumberValue", personal ? `${personal.toFixed(1)} cm` : "측정 부족", personal >= 20 && personal <= 65 ? "good" : "watch", personal >= 20 && personal <= 65 ? "✓" : "!");

  const balanceGood = analysis.releaseBalance >= 82;
  setPoseMetric("releaseBalanceValue", `${analysis.releaseBalance}%`, balanceGood ? "good" : analysis.releaseBalance >= 68 ? "watch" : "warn", balanceGood ? "✓" : analysis.releaseBalance >= 68 ? "!" : "×");
  $("#releaseBalanceNote").textContent = balanceGood ? "피니시 중심이 안정적이에요" : "릴리스 후 머리·골반 흔들림 감지";

  const shoulderGood = analysis.shoulderTilt <= 18;
  setPoseMetric("shoulderTiltValue", `${analysis.shoulderTilt.toFixed(1)}°`, shoulderGood ? "good" : "watch", shoulderGood ? "✓" : "!");
  $("#shoulderTiltNote").textContent = shoulderGood ? "좌우 어깨선 안정" : "릴리스 구간 어깨 기울기 큼";
}

$$("[data-body-filter]").forEach(button => button.addEventListener("click", () => {
  const filter = button.dataset.bodyFilter;
  $$("[data-body-filter]").forEach(item => item.classList.toggle("active", item === button));
  $$("[data-body-part]").forEach(card => {
    card.hidden = filter !== "all" && card.dataset.bodyPart !== filter;
  });
}));

$$("[data-body-part]").forEach(card => {
  card.hidden = card.dataset.bodyPart !== "upper";
});

function saveShot(result) {
  state.history.unshift({ ...result, time: Date.now() });
  state.history = state.history.slice(0, 30);
  storageSafe("lane-lab-history", JSON.stringify(state.history));
  renderHistory();
}

$("#calibrateButton").addEventListener("click", () => {
  setPage("coach");
  if (activePatternImage) {
    $("#patternCalibrateToggle").click();
  } else {
    showToast("카메라에서 패턴 맞춤으로 레인을 맞춰주세요.");
  }
});

$("#expandCamera").addEventListener("click", () => {
  const card = $(".camera-card");
  const expanded = card.classList.toggle("expanded");
  document.body.classList.toggle("camera-expanded", expanded);
  $("#expandCamera").textContent = expanded ? "✕" : "⛶";
  $("#expandCamera").setAttribute("aria-label", expanded ? "전체 화면 닫기" : "촬영 화면 크게 보기");
  setTimeout(resizeCanvas, 120);
});

function speak(text) {
  if (!("speechSynthesis" in window)) return showToast("음성 읽기를 지원하지 않는 브라우저예요.");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ko-KR";
  utterance.rate = .95;
  speechSynthesis.speak(utterance);
}

$("#speakFeedback").addEventListener("click", () => speak(`${$("#coachTitle").textContent} ${$("#coachText").textContent}`));
$("#soundToggle").addEventListener("click", event => {
  state.sound = !state.sound;
  event.currentTarget.classList.toggle("on", state.sound);
  $("#voiceSetting").checked = state.sound;
  showToast(`자동 음성 코칭을 ${state.sound ? "켰어요" : "껐어요"}.`);
});
$("#voiceSetting").addEventListener("change", event => {
  state.sound = event.target.checked;
  $("#soundToggle").classList.toggle("on", state.sound);
});

const builtInPatterns = {
  house: { length: "40 ft", ratio: "8 : 1", difficulty: "보통", oil: "63%", boards: [23,14,8], reason: "마른 바깥쪽을 활용해 백엔드 반응을 확보하세요." },
  sport: { length: "41 ft", ratio: "3 : 1", difficulty: "어려움", oil: "66%", boards: [20,13,10], reason: "오일 경계가 좁습니다. 각을 줄이고 직선적으로 공략하세요." },
  short: { length: "35 ft", ratio: "4 : 1", difficulty: "어려움", oil: "52%", boards: [28,17,5], reason: "빠른 마찰에 대비해 안쪽에서 바깥쪽으로 공간을 만드세요." },
  long: { length: "47 ft", ratio: "2.5 : 1", difficulty: "매우 어려움", oil: "77%", boards: [16,11,9], reason: "브레이크가 늦습니다. 표면이 강한 볼로 라인을 단순화하세요." }
};

let customPatterns = JSON.parse(localStorage.getItem("lane-lab-patterns") || "[]");

function boardToLaneX(board) {
  return 162 - Math.max(1, Math.min(39, Number(board))) / 39 * 144;
}

function updateRecommendedPath(boards) {
  if (!$("#targetPath")) return;
  const [standing, aim, breakpoint] = boards.map(Number);
  const startX = boardToLaneX(standing);
  const aimX = boardToLaneX(aim);
  const breakX = boardToLaneX(breakpoint);
  const pocketX = boardToLaneX(17.5);
  const path = [
    `M ${startX.toFixed(1)} 565`,
    `C ${startX.toFixed(1)} 470, ${(startX * .55 + aimX * .45).toFixed(1)} 365, ${aimX.toFixed(1)} 300`,
    `C ${(aimX * .65 + breakX * .35).toFixed(1)} 235, ${breakX.toFixed(1)} 155, ${breakX.toFixed(1)} 112`,
    `C ${breakX.toFixed(1)} 78, ${(breakX * .35 + pocketX * .65).toFixed(1)} 47, ${pocketX.toFixed(1)} 35`
  ].join(" ");
  $("#targetPath").setAttribute("d", path);
  $(".target-path-shadow")?.setAttribute("d", path);
  $(".start-dot")?.setAttribute("cx", startX);
  $(".break-dot")?.setAttribute("cx", breakX);
  $(".break-dot")?.setAttribute("cy", 112);
  $(".lane-label.start")?.style.setProperty("left", `${startX / 180 * 100}%`);
  $(".lane-label.arrows")?.style.setProperty("left", `${aimX / 180 * 100}%`);
  $(".lane-label.break")?.style.setProperty("left", `${breakX / 180 * 100}%`);
}

function createPatternTexture(pattern) {
  const texture = document.createElement("canvas");
  texture.width = 180;
  texture.height = 620;
  const context = texture.getContext("2d");
  const oilLength = Math.max(30, Math.min(52, Number.parseFloat(pattern.length) || 40));
  const oilBottom = texture.height;
  const oilTop = texture.height * (1 - oilLength / 60);
  const centerBoard = Number(pattern.boards?.[1]) || 20;
  const centerX = (39 - centerBoard) / 38 * texture.width;
  const ratio = Math.max(1, Number.parseFloat(pattern.ratio) || 3);

  context.fillStyle = "rgba(73,92,255,.20)";
  context.fillRect(0, oilTop, texture.width, oilBottom - oilTop);
  for (let row = oilTop; row < oilBottom; row += 12) {
    const progress = (row - oilTop) / Math.max(1, oilBottom - oilTop);
    const halfWidth = 22 + progress * (52 + ratio * 3);
    const gradient = context.createLinearGradient(centerX - halfWidth, 0, centerX + halfWidth, 0);
    gradient.addColorStop(0, "rgba(70,75,220,.08)");
    gradient.addColorStop(.2, "rgba(75,70,235,.48)");
    gradient.addColorStop(.5, "rgba(43,37,178,.84)");
    gradient.addColorStop(.8, "rgba(75,70,235,.48)");
    gradient.addColorStop(1, "rgba(70,75,220,.08)");
    context.fillStyle = gradient;
    context.fillRect(centerX - halfWidth, row, halfWidth * 2, 13);
  }
  context.fillStyle = "rgba(85,234,218,.5)";
  context.fillRect(0, Math.max(oilTop, oilBottom - 80), texture.width, 80);
  return texture.toDataURL("image/png");
}

function applyPattern(p, activeKey) {
  state.activePatternKey = activeKey;
  state.pendingPatternKey = activeKey;
  $$(".pattern-tabs button").forEach(item => item.classList.remove("active"));
  $$(".saved-pattern-chip").forEach(item => item.classList.remove("active"));
  const builtInButton = $(`.pattern-tabs button[data-pattern="${activeKey}"]`);
  if (builtInButton) builtInButton.classList.add("active");
  const customButton = $(`.saved-pattern-chip[data-pattern-id="${activeKey}"]`);
  if (customButton) customButton.classList.add("active");
  const set = (id, value) => { const el = $(`#${id}`); if (el) el.textContent = value; };
  set("patternLength", p.length);
  set("patternRatio", p.ratio);
  set("patternDifficulty", p.difficulty);
  set("standingBoard", p.boards[0]);
  set("aimBoard", p.boards[1]);
  set("breakBoard", p.boards[2]);
  updateRecommendedPath(p.boards);
  set("lineRecommendation", `${p.boards[0]} → ${p.boards[1]} → ${p.boards[2]} 보드`);
  set("lineReason", p.reason);
  const patternImage = p.image || createPatternTexture(p);
  setPatternOverlayImage(patternImage, p.name || patternNames?.[activeKey] || "OIL PATTERN", true);
  lanePatternOverlay.classList.add("visible");
  renderPatternProjection();
}

function applyAnalyzedPattern(analysis, image) {
  const length = analysis.length || Number.parseInt($("#patternLength").textContent, 10) || 40;
  const ratio = analysis.ratio || Number.parseFloat($("#patternRatio").textContent) || 3;
  const volumeText = analysis.volume ? `${analysis.volume.toFixed(2)} mL` : "미인식";
  const difficulty = ratio >= 6 ? "보통" : ratio >= 3 ? "어려움" : "매우 어려움";
  const pattern = {
    id: `scan-${Date.now()}`,
    name: analysis.name || "분석 패턴",
    length: `${length} ft`,
    ratio: `${ratio.toFixed(1)} : 1`,
    difficulty,
    oil: `${Math.round(Math.max(42, Math.min(86, length / 60 * 100)))}%`,
    boards: analysis.boards,
    reason: `${length}ft 패턴입니다. Rule of 31 기준 브레이크 ${analysis.boards[2]}보드부터 시작해 실제 볼 반응에 따라 조정하세요.${analysis.volume ? ` 총 오일량 ${analysis.volume.toFixed(2)}mL.` : ""}`,
    image,
    volume: analysis.volume
  };
  customPatterns = customPatterns.filter(item => item.name !== pattern.name);
  customPatterns.unshift(pattern);
  customPatterns = customPatterns.slice(0, 24);
  storageSafe("lane-lab-patterns", JSON.stringify(customPatterns));
  renderCustomPatterns();
  applyPattern(pattern, pattern.id);
  $("#patternAnalysisTitle").textContent = analysis.confidence >= .66 ? "패턴 정보 자동 적용 완료" : "일부 정보만 인식됨";
  $("#patternAnalysisStatus").textContent = analysis.length
    ? "인식값을 레인 정보와 추천 라인에 반영했습니다."
    : "패턴 길이를 읽지 못해 기존 길이를 사용했습니다.";
  $("#patternAnalysisResult").hidden = false;
  $("#analyzedPatternName").textContent = pattern.name;
  $("#analyzedPatternLength").textContent = analysis.length ? `${analysis.length} ft` : "확인 필요";
  $("#analyzedPatternVolume").textContent = volumeText;
  $("#analyzedPatternLine").textContent = pattern.boards.join(" → ");
  $("#customPatternName").value = pattern.name;
  $("#customPatternLength").value = length;
  $("#customPatternRatio").value = ratio.toFixed(1);
  $("#customStanding").value = pattern.boards[0];
  $("#customAim").value = pattern.boards[1];
  $("#customBreak").value = pattern.boards[2];
  $("#customDifficulty").value = difficulty;
  $("#customReason").value = pattern.reason;
}

$$(".pattern-tabs button").forEach(button => button.addEventListener("click", () => {
  applyPattern(builtInPatterns[button.dataset.pattern], button.dataset.pattern);
}));

function renderCustomPatterns() {
  const container = $("#savedPatterns");
  container.innerHTML = customPatterns.map(pattern => `
    <button class="saved-pattern-chip" data-pattern-id="${pattern.id}" type="button">
      ${pattern.image ? `<img src="${pattern.image}" alt="">` : `<span class="pattern-mini-lane"></span>`}
      <b>${pattern.name}</b><small>${pattern.length} · ${pattern.ratio}</small>
      <i data-delete-pattern="${pattern.id}" title="삭제">×</i>
    </button>
  `).join("");
  $$(".saved-pattern-chip", container).forEach(button => button.addEventListener("click", event => {
    const deleteId = event.target.dataset.deletePattern;
    if (deleteId) {
      event.stopPropagation();
      if (!confirm("이 시합 패턴을 삭제할까요?")) return;
      customPatterns = customPatterns.filter(pattern => pattern.id !== deleteId);
      storageSafe("lane-lab-patterns", JSON.stringify(customPatterns));
      renderCustomPatterns();
      applyPattern(builtInPatterns.house, "house");
      showToast("패턴을 삭제했어요.");
      return;
    }
    const pattern = customPatterns.find(item => item.id === button.dataset.patternId);
    if (pattern) applyPattern(pattern, pattern.id);
  }));
}

const patternNames = {
  house: "하우스 패턴",
  sport: "스포츠 패턴",
  short: "숏 패턴",
  long: "롱 패턴"
};

function getPatternByKey(key) {
  return builtInPatterns[key] || customPatterns.find(pattern => pattern.id === key);
}

function renderPatternPicker() {
  const items = [
    ...Object.entries(builtInPatterns).map(([key, pattern]) => ({ key, name: patternNames[key], pattern })),
    ...customPatterns.map(pattern => ({ key: pattern.id, name: pattern.name, pattern }))
  ];
  $("#patternPickerList").innerHTML = items.map(({ key, name, pattern }) => `
    <button class="pattern-picker-item ${state.pendingPatternKey === key ? "selected" : ""}" data-picker-pattern="${key}" type="button">
      ${pattern.image ? `<img src="${pattern.image}" alt="">` : ""}
      <b>${name}</b>
      <small>${pattern.length} · 비율 ${pattern.ratio}</small>
      <em>${pattern.difficulty || "사용자 패턴"}</em>
    </button>
  `).join("");
  $$("[data-picker-pattern]", $("#patternPickerList")).forEach(button => button.addEventListener("click", () => {
    state.pendingPatternKey = button.dataset.pickerPattern;
    renderPatternPicker();
  }));
}

function closePatternPicker() {
  $("#patternPickerSheet").hidden = true;
}

function closePatternSource() {
  $("#patternSourceSheet").hidden = true;
}

$("#openPatternSource").addEventListener("click", () => {
  $("#patternSourceSheet").hidden = false;
});
$("#openPatternSourceFromPicker").addEventListener("click", () => {
  closePatternPicker();
  $("#patternSourceSheet").hidden = false;
});
$("#closePatternSource").addEventListener("click", closePatternSource);
$("#cancelPatternSource").addEventListener("click", closePatternSource);

$("#railLaneButton").addEventListener("click", () => {
  if (!activePatternImage) {
    showToast("먼저 패턴 이미지를 등록하거나 패턴을 선택하세요.");
    setPage("coach");
    return;
  }
  $("#patternCalibrateToggle").click();
});

$("#railTrajectoryButton").addEventListener("click", event => {
  state.trajectoryVisible = !state.trajectoryVisible;
  stage.classList.toggle("hide-analysis-overlay", !state.trajectoryVisible);
  event.currentTarget.classList.toggle("active", state.trajectoryVisible);
  showToast(state.trajectoryVisible ? "관절과 공 궤적을 표시합니다." : "분석선을 잠시 숨겼어요.");
});

$("#railPatternButton").addEventListener("click", () => {
  state.pendingPatternKey = state.activePatternKey;
  renderPatternPicker();
  $("#patternPickerSheet").hidden = false;
});

$("#closePatternSheet").addEventListener("click", closePatternPicker);
$("#cancelPatternSheet").addEventListener("click", closePatternPicker);
$("#confirmPatternSheet").addEventListener("click", () => {
  const pattern = getPatternByKey(state.pendingPatternKey);
  if (!pattern) return;
  applyPattern(pattern, state.pendingPatternKey);
  closePatternPicker();
  $("#railPatternButton").classList.add("active");
  showToast("선택한 패턴을 분석 화면에 적용했어요.");
});

$("#viewAnalysisResult").addEventListener("click", () => {
  $("#viewAnalysisResult").hidden = true;
  setPage("coach");
  requestAnimationFrame(() => $("#proShotResult").scrollIntoView({ behavior: "smooth", block: "start" }));
});

$("#openPatternForm").addEventListener("click", () => {
  $("#patternForm").hidden = false;
  $("#openPatternForm").hidden = true;
  $("#customPatternName").focus();
});

$("#cancelPattern").addEventListener("click", () => {
  $("#patternForm").hidden = true;
  $("#openPatternForm").hidden = false;
});

$("#patternForm").addEventListener("submit", async event => {
  event.preventDefault();
  const length = Number($("#customPatternLength").value);
  const ratio = Number($("#customPatternRatio").value);
  const patternFile = $("#customPatternImage").files[0];
  let patternImage = "";
  if (patternFile) {
    try {
      const processed = await processPatternImage(patternFile);
      patternImage = processed.overlay;
    } catch {
      showToast("패턴 이미지는 제외하고 저장합니다.");
    }
  }
  const pattern = {
    id: `custom-${Date.now()}`,
    name: $("#customPatternName").value.trim(),
    length: `${length} ft`,
    ratio: `${ratio} : 1`,
    difficulty: $("#customDifficulty").value,
    oil: `${Math.round(Math.max(42, Math.min(86, length / 60 * 100)))}%`,
    boards: [
      Number($("#customStanding").value),
      Number($("#customAim").value),
      Number($("#customBreak").value)
    ],
    reason: $("#customReason").value.trim() || "등록한 시합 패턴과 볼 반응을 비교하며 라인을 조정하세요.",
    image: patternImage
  };
  customPatterns.unshift(pattern);
  storageSafe("lane-lab-patterns", JSON.stringify(customPatterns));
  renderCustomPatterns();
  applyPattern(pattern, pattern.id);
  event.target.reset();
  $("#customPatternLength").value = 41;
  $("#customPatternRatio").value = 3;
  $("#customStanding").value = 20;
  $("#customAim").value = 13;
  $("#customBreak").value = 8;
  event.target.hidden = true;
  $("#openPatternForm").hidden = false;
  showToast(`${pattern.name} 패턴을 저장했어요.`);
});

renderCustomPatterns();
updateRecommendedPath(builtInPatterns.house.boards);

function renderHistory() {
  const list = $("#historyList");
  $("#shotCount").textContent = state.history.length;
  const consistency = computeConsistency(state.history);
  $("#consistencyScore").textContent = consistency ? consistency.score : "—";
  $("#consistencyNote").textContent = consistency
    ? `최근 ${consistency.samples}샷 기준`
    : "샷 2개 이상부터 측정";
  if (!state.history.length) {
    $("#averageScore").textContent = "—";
    $("#bestScore").textContent = "—";
    list.innerHTML = `<div class="empty-history"><span>◎</span><h2>아직 기록된 샷이 없어요</h2><p>카메라 세션을 시작하거나<br>영상을 불러와 분석해보세요.</p><button data-go="coach">첫 샷 시작하기</button></div>`;
    return;
  }
  const avg = Math.round(state.history.reduce((sum, shot) => sum + shot.score, 0) / state.history.length);
  $("#averageScore").textContent = avg;
  $("#bestScore").textContent = Math.max(...state.history.map(shot => shot.score));
  list.innerHTML = state.history.map((shot, index) => {
    const date = new Date(shot.time);
    const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const speedText = shot.speed ? `${shot.speed.toFixed(1)} km/h` : "속도 미측정";
    const rpmText = shot.rpm ? ` · ${shot.rpm} RPM` : "";
    return `<article class="history-item"><div class="history-score">${shot.score}</div><div><h3>샷 #${state.history.length - index}</h3><p>${speedText} · 릴리스 ${shot.release.toFixed(1)}° · 밸런스 ${shot.balance}%${rpmText}</p></div><time>${time}</time></article>`;
  }).join("");
}

$("#historyList").addEventListener("click", event => {
  const button = event.target.closest("[data-go]");
  if (button) setPage(button.dataset.go);
});

$("#clearHistory").addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("lane-lab-history");
  renderHistory();
  showToast("샷 기록을 초기화했어요.");
});

$("#handedness").addEventListener("change", event => {
  $("#poseTrackingSide").textContent = `${event.target.value} 기준`;
  showToast(`${event.target.value} 기준으로 분석합니다.`);
});

function applyCaptureMode(mode, notify = false) {
  state.captureMode = mode === "action" ? "action" : "phone";
  $("#captureMode").value = state.captureMode;
  $("#captureModeLabel").textContent = state.captureMode === "action"
    ? "고정 액션캠 · 후면"
    : "후면 · 세로 촬영";
  stage.classList.toggle("action-cam-mode", state.captureMode === "action");
  storageSafe("lane-lab-capture-mode", state.captureMode);
  state.ballTracker = null;
  state.autoBallLock = null;
  state.trajectory = [];
  state.showFinalTrajectory = false;
  if (notify) {
    showToast(state.captureMode === "action"
      ? "액션캠 구도에 맞춰 전신·공 추적 범위를 넓혔어요."
      : "휴대폰 후면 촬영 모드로 변경했어요.");
  }
}

$("#captureMode").addEventListener("change", event => {
  applyCaptureMode(event.target.value, true);
});

applyCaptureMode(state.captureMode);

renderHistory();
resetShotReport();
drawShotResult(null, null);
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
