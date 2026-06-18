const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  stream: null,
  facingMode: "environment",
  running: false,
  demoRunning: false,
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
  ballTracker: null,
  lastBallScanAt: 0,
  trackerCanvas: document.createElement("canvas"),
  ballLockArmed: false,
  ballColor: null,
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

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
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
video.addEventListener("play", updateVideoPlaybackUI);
video.addEventListener("pause", updateVideoPlaybackUI);
video.addEventListener("ended", () => {
  updateVideoPlaybackUI();
  $("#modelStatus").textContent = "영상 분석 완료";
});

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
    localStorage.setItem("lane-lab-active-pattern-image", activePatternImage);
  } else {
    localStorage.removeItem("lane-lab-active-pattern-image");
  }
  lanePatternOverlay.classList.toggle("visible", Boolean(activePatternImage && show));
  $("#togglePatternOverlay").textContent = lanePatternOverlay.classList.contains("visible") ? "표시 중" : "바닥 표시";
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
        resolve({
          overlay: output.toDataURL("image/jpeg", .78),
          source: reader.result,
          graph: analyzeOilGraph(output)
        });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

$("#patternImageUpload").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    $("#patternAnalysisTitle").textContent = "패턴표 분석 중";
    $("#patternAnalysisStatus").textContent = "오일 그래프를 찾고 있습니다.";
    $("#patternAnalysisResult").hidden = true;
    const processed = await processPatternImage(file);
    const fallbackName = file.name.replace(/\.[^.]+$/, "");
    setPatternOverlayImage(processed.overlay, fallbackName, true);
    const analysis = await recognizePatternDocument(processed.source, fallbackName);
    if (!analysis.ratio && processed.graph.ratio) analysis.ratio = processed.graph.ratio;
    applyAnalyzedPattern(analysis, processed.overlay);
    showToast(analysis.length ? "패턴 정보를 읽어 레인에 적용했어요." : "그래프는 적용했지만 길이는 확인이 필요합니다.");
  } catch {
    showToast("패턴표 이미지를 읽을 수 없어요.");
  }
});

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
  const opacity = Number($("#cameraPatternOpacity").value) / 100;
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
  if (save) {
    localStorage.setItem("lane-lab-overlay-settings", JSON.stringify({ corners: patternCorners, opacity }));
  }
}

$("#cameraPatternOpacity").addEventListener("input", () => updateOverlayControls());

const savedOverlaySettings = JSON.parse(localStorage.getItem("lane-lab-overlay-settings") || "null");
if (savedOverlaySettings?.corners) {
  patternCorners = savedOverlaySettings.corners;
  $("#cameraPatternOpacity").value = Math.round((savedOverlaySettings.opacity || .30) * 100);
  updateOverlayControls(false);
} else if (savedOverlaySettings?.topWidth) {
  const center = savedOverlaySettings.center || 50;
  patternCorners = {
    topLeft: { x: center - savedOverlaySettings.topWidth / 2, y: Number.parseInt(savedOverlaySettings.top, 10) || 23 },
    topRight: { x: center + savedOverlaySettings.topWidth / 2, y: Number.parseInt(savedOverlaySettings.top, 10) || 23 },
    bottomLeft: { x: center - savedOverlaySettings.bottomWidth / 2, y: Number.parseInt(savedOverlaySettings.bottom, 10) || 96 },
    bottomRight: { x: center + savedOverlaySettings.bottomWidth / 2, y: Number.parseInt(savedOverlaySettings.bottom, 10) || 96 }
  };
  $("#cameraPatternOpacity").value = Math.round((savedOverlaySettings.opacity || .30) * 100);
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
    const result = autoDetectLane();
    if (result) {
      patternCorners = result.corners;
      updateOverlayControls();
      showToast(result.confidence >= .45
        ? "레인 경계를 자동으로 맞췄어요."
        : "자동으로 배치했어요. 모서리만 확인해주세요.");
    } else {
      showToast("자동 감지 실패 · 네 모서리를 손가락으로 맞춰주세요.");
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

$("#autoFitPattern").addEventListener("click", () => {
  const result = autoDetectLane();
  if (!result) {
    showToast("레인 경계를 찾지 못했어요. 영상 위치를 조금 옮겨주세요.");
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
  $("#ballLockToggle").textContent = state.ballLockArmed ? "공을 눌러주세요" : (state.ballColor ? "공 지정됨" : "공 지정");
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
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],
  [27,29],[29,31],[28,30],[30,32]
];

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
  if (!state.smoothedPose || state.smoothedPose.length !== rawPoints.length) {
    state.smoothedPose = rawPoints;
  } else {
    state.smoothedPose = rawPoints.map((point, index) => {
      const previous = state.smoothedPose[index];
      const alpha = point.visibility > .7 ? .36 : .18;
      const jump = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (jump > Math.max(stage.clientWidth, stage.clientHeight) * .11 && point.visibility < .88) {
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
    if (points[a].visibility < .45 || points[b].visibility < .45) return;
    const arm = [11,12,13,14,15,16].includes(a) && [11,12,13,14,15,16].includes(b);
    ctx.strokeStyle = arm ? "rgba(201,255,61,.78)" : "rgba(80,217,205,.58)";
    ctx.lineWidth = arm ? 2.4 : 1.7;
    ctx.beginPath();
    ctx.moveTo(points[a].x, points[a].y);
    ctx.lineTo(points[b].x, points[b].y);
    ctx.stroke();
  });

  points.forEach((point, index) => {
    if (index < 11 || point.visibility < .5) return;
    ctx.fillStyle = "#07110f";
    ctx.strokeStyle = "#c9ff3d";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  const trajectoryTravel = state.trajectory.length > 2
    ? Math.hypot(
        state.trajectory[state.trajectory.length - 1].x - state.trajectory[0].x,
        state.trajectory[state.trajectory.length - 1].y - state.trajectory[0].y
      )
    : 0;
  if (state.showFinalTrajectory && state.ballTracker?.valid && state.trajectory.length >= 8 && trajectoryTravel > 40) {
    ctx.strokeStyle = "#ff7043";
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.shadowColor = "rgba(255,112,67,.65)";
    ctx.shadowBlur = 9;
    ctx.beginPath();
    const line = smoothTrajectory(state.trajectory);
    line.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.stroke();
    const ball = line[line.length - 1];
    ctx.fillStyle = "#ff7043";
    ctx.shadowColor = "#ff7043";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.font = "700 8px sans-serif";
    ctx.fillText("BALL LINE", ball.x + 10, ball.y - 8);
  }
  ctx.restore();
  return points;
}

function laneBoundsAtStageY(y) {
  const height = stage.clientHeight;
  const width = stage.clientWidth;
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
  if (points.length < 8) return { valid: false, reason: "프레임 부족" };
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
  const valid = verticalTravel > stage.clientHeight * .18
    && duration >= .65
    && duration <= 4.5
    && forwardRatio >= .78
    && laneRatio >= .88
    && jumpSteps <= 1;
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
  if (!validation.valid) return { valid: false, validation };
  const line = smoothTrajectory(points);
  const lanePoints = line.map((point, index) => ({
    ...point,
    index,
    lane: stagePointToLaneData(point)
  })).filter(point => point.lane);
  if (lanePoints.length < 8) return { valid: false, validation };

  let breakCandidate = lanePoints[Math.floor(lanePoints.length * .65)];
  let bestCurveScore = -Infinity;
  for (let index = 2; index < lanePoints.length - 2; index++) {
    const current = lanePoints[index];
    if (current.lane.feet < 28 || current.lane.feet > 52) continue;
    const before = lanePoints[index - 2];
    const after = lanePoints[index + 2];
    const headingBefore = Math.atan2(current.x - before.x, before.y - current.y);
    const headingAfter = Math.atan2(after.x - current.x, current.y - after.y);
    const curve = Math.abs(headingAfter - headingBefore);
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

  return {
    valid: true,
    validation,
    line: lanePoints,
    release: lanePoints[0],
    breakpoint: breakCandidate,
    entry: entryEnd,
    entryAngle,
    speed,
    duration: (lanePoints[lanePoints.length - 1].time - lanePoints[0].time) / 1000
  };
}

function drawShotResult(motion) {
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
  if (!motion?.valid) {
    $("#trackingQuality").textContent = "궤적 미확정";
    $("#trackingQuality").className = "tracking-quality fail";
    ["resultBallSpeed", "resultBreakBoard", "resultEntryBoard", "resultEntryAngle"].forEach(id => $(`#${id}`).textContent = "—");
    $("#resultBreakDistance").textContent = "— ft";
    $("#resultTrackFrames").textContent = "0";
    $("#resultTrackTime").textContent = "—초";
    return;
  }

  const mapPoint = point => ({
    x: 18 + (39 - point.lane.board) / 38 * (displayWidth - 36),
    y: displayHeight - 18 - point.lane.progress * (displayHeight - 54)
  });
  const mapped = motion.line.map(mapPoint);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(7,17,15,.42)";
  context.lineWidth = 10;
  context.beginPath();
  mapped.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  context.strokeStyle = "#6b64ff";
  context.lineWidth = 4;
  context.shadowColor = "rgba(107,100,255,.8)";
  context.shadowBlur = 10;
  context.beginPath();
  mapped.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  context.shadowBlur = 0;

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

  $("#trackingQuality").textContent = `궤적 확정 · ${Math.round(motion.validation.forwardRatio * 100)}%`;
  $("#trackingQuality").className = "tracking-quality good";
  $("#resultBallSpeed").textContent = motion.speed ? motion.speed.toFixed(1) : "—";
  $("#resultBreakBoard").textContent = motion.breakpoint.lane.board.toFixed(1);
  $("#resultBreakDistance").textContent = `${motion.breakpoint.lane.feet.toFixed(0)} ft`;
  $("#resultEntryBoard").textContent = motion.entry.lane.board.toFixed(1);
  $("#resultEntryAngle").textContent = motion.entryAngle.toFixed(1);
  $("#resultTrackFrames").textContent = motion.line.length;
  $("#resultTrackTime").textContent = `${motion.duration.toFixed(2)}초`;
  $("#resultRpm").textContent = "—";
  $("#rpmNote").textContent = state.ballColor ? "고속 촬영·회전 마커 필요" : "공 표면 마커 필요";
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

function resetBallTracker(timestamp = performance.now()) {
  state.ballTracker = {
    startedAt: timestamp,
    releaseAt: 0,
    arrivalAt: 0,
    lastSeenAt: 0,
    previous: null,
    detected: false,
    candidateFrames: 0,
    previousLuma: null,
    origin: null,
    confirmed: false,
    valid: false,
    missedFrames: 0
  };
  state.trajectory = [];
  state.showFinalTrajectory = false;
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
  if (timestamp - state.ballTracker.startedAt < 420) return;
  if (timestamp - state.lastBallScanAt < 48) return;
  state.lastBallScanAt = timestamp;
  const tracker = state.trackerCanvas;
  const tw = 216;
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
      if (!state.ballColor && dark < Math.max(3, total * .32)) continue;
      if (previousLuma && moving < Math.max(2, total * .2)) continue;
      const averageColor = { r: redTotal / total, g: greenTotal / total, b: blueTotal / total };
      const colorDistance = state.ballColor
        ? Math.hypot(
            averageColor.r - state.ballColor.r,
            averageColor.g - state.ballColor.g,
            averageColor.b - state.ballColor.b
          )
        : 0;
      if (state.ballColor && colorDistance > 105) continue;
      const cx = x + block / 2;
      const cy = y + block / 2;
      const wristDistance = Math.hypot(cx - wristSource.x, cy - wristSource.y);
      const nearBody = excludedPose.some((point, index) => {
        const radius = index < 3 ? tw * .095 : tw * .07;
        return Math.hypot(cx - point.x, cy - point.y) < radius;
      });
      if (nearBody && wristDistance > tw * .15) continue;
      let score = dark * 4 + moving * 5;
      if (state.ballColor) score += Math.max(0, 120 - colorDistance) * .7;
      if (previous) {
        const distance = Math.hypot(cx - previous.x, cy - previous.y);
        if (distance > 42 || cy > previous.y + 9) continue;
        if (state.ballTracker.candidateFrames > 3 && cy >= previous.y + 1) continue;
        if (state.ballTracker.origin) {
          const previousTravel = Math.hypot(previous.x - state.ballTracker.origin.x, previous.y - state.ballTracker.origin.y);
          const nextTravel = Math.hypot(cx - state.ballTracker.origin.x, cy - state.ballTracker.origin.y);
          if (state.ballTracker.candidateFrames > 3 && nextTravel + 2 < previousTravel) continue;
          score += Math.max(0, nextTravel - previousTravel) * 4;
        }
        score += Math.max(0, 55 - distance) * 2;
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
    state.ballTracker.candidateFrames = Math.max(0, state.ballTracker.candidateFrames - 1);
    state.ballTracker.missedFrames++;
    if (
      state.ballTracker.confirmed &&
      !state.ballTracker.arrivalAt &&
      state.ballTracker.missedFrames >= 4 &&
      state.ballTracker.previous?.y < th * .48
    ) {
      state.ballTracker.arrivalAt = state.ballTracker.lastSeenAt;
    }
    if (!state.ballTracker.confirmed && state.ballTracker.missedFrames > 3) {
      state.ballTracker.previous = null;
      state.ballTracker.origin = null;
      state.trajectory = [];
    }
    return;
  }

  const stagePoint = sourceToStage(best.x, best.y, tw, th);
  if (!isInsideLane(stagePoint, 8)) {
    state.ballTracker.previousLuma = luma;
    state.ballTracker.missedFrames++;
    return;
  }
  state.ballTracker.missedFrames = 0;
  state.ballTracker.candidateFrames++;
  state.ballTracker.previous = best;
  if (!state.ballTracker.origin) state.ballTracker.origin = { x: best.x, y: best.y };
  state.ballTracker.previousLuma = luma;
  state.ballTracker.lastSeenAt = timestamp;
  if (state.ballTracker.candidateFrames < 3) return;
  state.ballTracker.detected = true;
  if (!state.ballTracker.releaseAt) state.ballTracker.releaseAt = timestamp;
  state.trajectory.push({ ...stagePoint, time: timestamp });
  state.trajectory = state.trajectory.slice(-90);
  const trackerTravel = Math.hypot(best.x - state.ballTracker.origin.x, best.y - state.ballTracker.origin.y);
  if (state.trajectory.length >= 8 && trackerTravel > 18) {
    const validation = validateTrajectory(state.trajectory);
    state.ballTracker.confirmed = validation.forwardRatio >= .7 && validation.laneRatio >= .8;
  }
  $("#modelStatus").innerHTML = "LIVE · <b>BALL TRACKING</b>";
  if (state.ballTracker.confirmed && best.y < th * .41) state.ballTracker.arrivalAt = timestamp;
}

function beginShot(timestamp) {
  if (timestamp - state.lastShotFinishedAt < 3500) return;
  state.shot = {
    startedAt: timestamp,
    lastMotionAt: timestamp,
    maxWristSpeed: 0,
    minKneeAngle: 180,
    releaseAngle: 0,
    trunkTilts: [],
    finishSamples: []
  };
  resetBallTracker(timestamp);
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
  const kneeQuality = Math.max(0, 100 - Math.abs((shot.minKneeAngle || 145) - 138) * 1.2);
  const avgTilt = shot.trunkTilts.length ? shot.trunkTilts.reduce((a,b) => a + b, 0) / shot.trunkTilts.length : 12;
  const tiltQuality = Math.max(0, 100 - Math.abs(avgTilt - 12) * 2.2);
  const finishMovement = shot.finishSamples.length ? shot.finishSamples.reduce((a,b) => a + b, 0) / shot.finishSamples.length : .04;
  const balance = Math.round(Math.max(55, Math.min(98, 98 - finishMovement * 220)));
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

  const result = {
    score,
    speed: speed || 0,
    release,
    board: 7 + Math.min(4, state.trajectory.length / 12),
    balance,
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
  drawShotResult(ballMotion);
  saveShot(result);
  setFlow("result");
  $(".feedback-float b").textContent = feedback[0];
  $(".feedback-float small").textContent = `${score}점 · ${speed ? `${speed.toFixed(1)}km/h` : "속도 측정 실패"} · 무릎 ${Math.round(shot.minKneeAngle)}°`;
  state.shot = null;
  state.prevWrist = null;
  state.lastShotFinishedAt = performance.now();
  stage.classList.remove("live-tracking");
  if (state.sound) speak(feedback.join(" "));
  showToast(`실시간 샷 분석 완료 · ${score}점`);
}

function analyzePose(points, timestamp) {
  const rightHanded = $("#handedness").value !== "왼손";
  const shoulder = points[rightHanded ? 12 : 11];
  const elbow = points[rightHanded ? 14 : 13];
  const wrist = points[rightHanded ? 16 : 15];
  const hip = points[rightHanded ? 24 : 23];
  const knee = points[rightHanded ? 26 : 25];
  const ankle = points[rightHanded ? 28 : 27];
  if ([shoulder, elbow, wrist, hip, knee, ankle].some(p => p.visibility < .42)) return;

  const normalizedWrist = { x: wrist.x / stage.clientWidth, y: wrist.y / stage.clientHeight, time: timestamp };
  if (state.prevWrist) {
    const dt = Math.max(.016, (timestamp - state.prevWrist.time) / 1000);
    const velocity = Math.hypot(normalizedWrist.x - state.prevWrist.x, normalizedWrist.y - state.prevWrist.y) / dt;

    if (!state.shot && velocity > .48) beginShot(timestamp);
    if (state.shot) {
      state.shot.maxWristSpeed = Math.max(state.shot.maxWristSpeed, velocity);
      state.shot.minKneeAngle = Math.min(state.shot.minKneeAngle, angleAt(hip, knee, ankle));
      state.shot.releaseAngle = Math.atan2(Math.abs(wrist.y - elbow.y), Math.abs(wrist.x - elbow.x)) * 180 / Math.PI;
      const trunkAngle = Math.atan2(Math.abs(shoulder.x - hip.x), Math.abs(shoulder.y - hip.y)) * 180 / Math.PI;
      state.shot.trunkTilts.push(trunkAngle);
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
          $("#modelStatus").innerHTML = "LIVE · <b>POSE</b>";
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
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 24 } },
      audio: false
    });
    video.srcObject = state.stream;
    video.removeAttribute("src");
    await video.play();
    state.running = true;
    state.fileVideo = false;
    $("#videoPlaybackControls").hidden = true;
    stage.classList.remove("file-video");
    state.prevWrist = null;
    state.shot = null;
    state.trajectory = [];
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

const feedbacks = [
  ["릴리스 타이밍이 아주 좋아요.", "마지막 스텝에서 상체가 조금 먼저 열렸어요. 왼쪽 어깨를 핀 방향에 0.2초 더 유지해보세요."],
  ["스윙 궤도가 안정적이에요.", "다운스윙에서 팔꿈치가 몸에서 약간 멀어졌어요. 겨드랑이를 가볍게 붙인 느낌을 유지하세요."],
  ["슬라이드 밸런스가 좋아졌어요.", "릴리스 직후 오른발이 조금 빨리 내려옵니다. 피니시 자세를 1초만 더 유지해보세요."],
  ["좋은 템포의 어프로치예요.", "세 번째 스텝이 약간 빨랐어요. 첫 두 스텝을 작고 편안하게 시작해보세요."]
];

function setMetrics(result) {
  $("#shotScore").textContent = result.score;
  $("#speedValue").textContent = result.speed ? result.speed.toFixed(1) : "—";
  $("#releaseValue").textContent = result.release.toFixed(1);
  $("#boardValue").textContent = result.board.toFixed(1);
  $("#balanceValue").textContent = result.balance;
  $(".balance-bar i").style.width = `${result.balance}%`;
  $("#coachTitle").textContent = result.feedback[0];
  $("#coachText").textContent = result.feedback[1];
  setFlow("coach");
}

function saveShot(result) {
  state.history.unshift({ ...result, time: Date.now() });
  state.history = state.history.slice(0, 30);
  localStorage.setItem("lane-lab-history", JSON.stringify(state.history));
  renderHistory();
}

function demoShot() {
  if (state.demoRunning) return;
  state.demoRunning = true;
  placeholder.classList.add("hidden");
  stage.classList.add("analyzing");
  $(".feedback-float").classList.remove("visible");
  let start;
  function animate(timestamp) {
    start ??= timestamp;
    const progress = Math.min((timestamp - start) / 2700, 1);
    drawGuide(progress);
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      const result = {
        score: Math.round(82 + Math.random() * 13),
        speed: 23.5 + Math.random() * 2.8,
        release: 15.1 + Math.random() * 2.5,
        board: 7.5 + Math.random() * 1.7,
        balance: Math.round(86 + Math.random() * 10),
        feedback: feedbacks[Math.floor(Math.random() * feedbacks.length)]
      };
      setMetrics(result);
      drawShotResult(null);
      saveShot(result);
      setFlow("result");
      stage.classList.remove("analyzing");
      $(".feedback-float").classList.add("visible");
      $(".feedback-float b").textContent = result.feedback[0];
      $(".feedback-float small").textContent = result.feedback[1].split(".")[0];
      state.demoRunning = false;
      if (state.sound) speak(result.feedback.join(" "));
      setTimeout(() => {
        if (!state.running) placeholder.classList.remove("hidden");
      }, 4200);
      showToast(`샷 분석 완료 · ${result.score}점`);
    }
  }
  requestAnimationFrame(animate);
}

$("#demoShot").addEventListener("click", demoShot);

$("#calibrateButton").addEventListener("click", () => {
  setPage("lane");
  showToast("레인 중앙과 보드 위치를 확인해주세요.");
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
  $(".target-path-shadow").setAttribute("d", path);
  $(".start-dot").setAttribute("cx", startX);
  $(".break-dot").setAttribute("cx", breakX);
  $(".break-dot").setAttribute("cy", 112);
  $(".lane-label.start").style.left = `${startX / 180 * 100}%`;
  $(".lane-label.arrows").style.left = `${aimX / 180 * 100}%`;
  $(".lane-label.break").style.left = `${breakX / 180 * 100}%`;
}

function applyPattern(p, activeKey) {
  $$(".pattern-tabs button").forEach(item => item.classList.remove("active"));
  $$(".saved-pattern-chip").forEach(item => item.classList.remove("active"));
  const builtInButton = $(`.pattern-tabs button[data-pattern="${activeKey}"]`);
  if (builtInButton) builtInButton.classList.add("active");
  const customButton = $(`.saved-pattern-chip[data-pattern-id="${activeKey}"]`);
  if (customButton) customButton.classList.add("active");
  $("#patternLength").textContent = p.length;
  $("#patternRatio").textContent = p.ratio;
  $("#patternDifficulty").textContent = p.difficulty;
  $("#oilZone").style.height = p.oil;
  $("#standingBoard").textContent = p.boards[0];
  $("#aimBoard").textContent = p.boards[1];
  $("#breakBoard").textContent = p.boards[2];
  $(".lane-label.start").textContent = p.boards[0];
  $(".lane-label.arrows").textContent = p.boards[1];
  $(".lane-label.break").textContent = p.boards[2];
  updateRecommendedPath(p.boards);
  $("#lineRecommendation").textContent = `${p.boards[0]} → ${p.boards[1]} → ${p.boards[2]} 보드`;
  $("#lineReason").textContent = p.reason;
  if (p.image) setPatternOverlayImage(p.image, p.name || "OIL PATTERN", true);
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
      <span>${pattern.name}</span><i data-delete-pattern="${pattern.id}" title="삭제">×</i>
    </button>
  `).join("");
  $$(".saved-pattern-chip", container).forEach(button => button.addEventListener("click", event => {
    const deleteId = event.target.dataset.deletePattern;
    if (deleteId) {
      event.stopPropagation();
      if (!confirm("이 시합 패턴을 삭제할까요?")) return;
      customPatterns = customPatterns.filter(pattern => pattern.id !== deleteId);
      localStorage.setItem("lane-lab-patterns", JSON.stringify(customPatterns));
      renderCustomPatterns();
      applyPattern(builtInPatterns.house, "house");
      showToast("패턴을 삭제했어요.");
      return;
    }
    const pattern = customPatterns.find(item => item.id === button.dataset.patternId);
    if (pattern) applyPattern(pattern, pattern.id);
  }));
}

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
  localStorage.setItem("lane-lab-patterns", JSON.stringify(customPatterns));
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

const moves = {
  pocket: ["유지", "현재 라인이 안정적입니다."],
  high: ["2 & 1 좌측", "발 2보드, 에임 1보드 왼쪽으로 이동하세요."],
  light: ["2 & 1 우측", "발 2보드, 에임 1보드 오른쪽으로 이동하세요."],
  washout: ["3 & 2 우측", "공이 밀리고 있습니다. 라인을 오른쪽으로 옮겨 마찰을 확보하세요."],
  split: ["1 & 1 좌측", "진입각이 큽니다. 각을 조금 줄여 포켓을 얇게 공략하세요."]
};

$("#calculateMove").addEventListener("click", () => {
  const move = moves[$("#shotResult").value];
  $("#moveResult").innerHTML = `<span>${move[0]}</span><p>${move[1]}</p>`;
  showToast("다음 샷 이동 위치를 계산했어요.");
});

function renderHistory() {
  const list = $("#historyList");
  $("#shotCount").textContent = state.history.length;
  if (!state.history.length) {
    $("#averageScore").textContent = "—";
    $("#bestScore").textContent = "—";
    list.innerHTML = `<div class="empty-history"><span>◎</span><h2>아직 기록된 샷이 없어요</h2><p>코치 화면에서 데모 샷을 분석하거나<br>카메라 세션을 시작해보세요.</p><button data-go="coach">첫 샷 시작하기</button></div>`;
    $("[data-go]", list).addEventListener("click", () => setPage("coach"));
    return;
  }
  const avg = Math.round(state.history.reduce((sum, shot) => sum + shot.score, 0) / state.history.length);
  $("#averageScore").textContent = avg;
  $("#bestScore").textContent = Math.max(...state.history.map(shot => shot.score));
  list.innerHTML = state.history.map((shot, index) => {
    const date = new Date(shot.time);
    const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const speedText = shot.speed ? `${shot.speed.toFixed(1)} km/h` : "속도 미측정";
    return `<article class="history-item"><div class="history-score">${shot.score}</div><div><h3>샷 #${state.history.length - index}</h3><p>${speedText} · 릴리스 ${shot.release.toFixed(1)}° · 밸런스 ${shot.balance}%</p></div><time>${time}</time></article>`;
  }).join("");
}

$("#clearHistory").addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("lane-lab-history");
  renderHistory();
  showToast("샷 기록을 초기화했어요.");
});

$("#handedness").addEventListener("change", event => {
  $("#targetPath").style.transform = event.target.value === "왼손" ? "scaleX(-1)" : "";
  $("#targetPath").style.transformOrigin = "center";
  showToast(`${event.target.value} 기준으로 분석합니다.`);
});

renderHistory();
drawShotResult(null);
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
