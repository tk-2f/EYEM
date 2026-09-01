class BlinkEngine {
  constructor(video, overlayCanvas) {
    this.video = video;
    this.canvas = overlayCanvas;
    this.ctx = this.canvas.getContext("2d");
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.rafId = 0;
    this.lastVideoTime = -1;
    this.results = null;
    this.isClosed = false;
    this.closedAt = 0;
    this.hasFace = false;
    this.ear = 0;
    this.earHistory = [];
    this.earSmoothing = 5;
    // calibrated thresholds (overwritten after calibration)
    this.CLOSED_THRESHOLD = 0.21;
    this.OPEN_THRESHOLD = 0.26;
    this.MIN_BLINK_MS = 150;
    this.DOT_MAX_MS = 700;
    this.DASH_MAX_MS = 2000;
    this.SEQUENCE_GAP_MS = 700;
    this.FLUSH_IDLE_MS = 750;
    this.lastClosedEnd = 0;
    this.seqCount = 0;
    this.seqFirstChar = "";
    this.LEFT_EYE = [33, 160, 158, 133, 153, 144];
    this.RIGHT_EYE = [362, 385, 387, 263, 373, 380];
    // calibration
    this.calibrating = false;
    this.calibSamples = [];
    this.calibDone = false;
    this._loop = this.loop.bind(this);
    this._onResize = () => this.syncSize();
    this._onVisibility = () => this.handleVisibility();
  }

  async start(handlers) {
    this.onSymbol = handlers.onSymbol || function () {};
    this.onState = handlers.onState || function () {};
    this.onSeparator = handlers.onSeparator || function () {};
    this.onCalibration = handlers.onCalibration || function () {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Camera API unavailable in this browser.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    this.video.srcObject = this.stream;
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) resolve();
      else this.video.onloadedmetadata = () => resolve();
    });
    await this.video.play();
    this.onState("model");
    await this.ensureModel();
    this.running = true;
    this.syncSize();
    window.addEventListener("resize", this._onResize);
    document.addEventListener("visibilitychange", this._onVisibility);
    // start calibration: 2s eyes-open baseline
    this.beginCalibration();
    this.rafId = requestAnimationFrame(this._loop);
  }

  async ensureModel() {
    if (this.landmarker) return;
    const baseUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
    let vision;
    try {
      vision = await import(baseUrl);
    } catch (err) {
      throw new Error("Failed to load MediaPipe from CDN. Check internet connection.");
    }
    let fileset;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(baseUrl + "/wasm");
    } catch (err) {
      throw new Error("Failed to load MediaPipe WASM. CDN may be blocked.");
    }
    const options = (delegate) => ({
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: delegate
      },
      runningMode: "VIDEO",
      numFaces: 1
    });
    try {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch (_gpuErr) {
      try {
        this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options("CPU"));
      } catch (cpuErr) {
        throw new Error("Failed to initialize FaceLandmarker (GPU and CPU failed): " + (cpuErr && cpuErr.message ? cpuErr.message : cpuErr));
      }
    }
  }

  beginCalibration() {
    this.calibrating = true;
    this.calibSamples = [];
    this.calibDone = false;
    this.onCalibration({ phase: "calibrating", progress: 0 });
    // auto-finish after 2.5s or 45 good samples
  }

  finishCalibration() {
    if (!this.calibSamples.length) {
      // fallback to defaults if no face during calibration
      this.calibrating = false;
      this.onCalibration({ phase: "done", earBase: null, fallback: true });
      return;
    }
    const sorted = [...this.calibSamples].sort((a, b) => a - b);
    // median open EAR
    const median = sorted[Math.floor(sorted.length / 2)];
    // thresholds as fractions of baseline — tuned for robustness
    this.CLOSED_THRESHOLD = Math.max(0.14, median * 0.62);
    this.OPEN_THRESHOLD = Math.max(0.17, median * 0.78);
    // clamp to sane range
    this.CLOSED_THRESHOLD = Math.min(this.CLOSED_THRESHOLD, 0.24);
    this.OPEN_THRESHOLD = Math.min(this.OPEN_THRESHOLD, 0.30);
    // ensure hysteresis gap
    if (this.OPEN_THRESHOLD - this.CLOSED_THRESHOLD < 0.04) {
      this.OPEN_THRESHOLD = this.CLOSED_THRESHOLD + 0.04;
    }
    this.calibrating = false;
    this.calibDone = true;
    this.onCalibration({ phase: "done", earBase: median, closed: this.CLOSED_THRESHOLD, open: this.OPEN_THRESHOLD });
  }

  syncSize() {
    const w = this.video.videoWidth || 640;
    const h = this.video.videoHeight || 480;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  handleVisibility() {
    if (document.hidden && this.running) {
      // pause is handled in loop via early return; keep running flag but skip detection
    }
  }

  loop() {
    if (!this.running) return;
    this.syncSize();
    const v = this.video;
    if (!document.hidden && v.readyState >= 2 && v.currentTime !== this.lastVideoTime && this.landmarker) {
      this.lastVideoTime = v.currentTime;
      try {
        this.results = this.landmarker.detectForVideo(v, performance.now());
      } catch (_err) {
        this.results = null;
      }
      this.processFrame();
    }
    if (!this.isClosed && this.seqCount > 0 && performance.now() - this.lastClosedEnd > this.FLUSH_IDLE_MS) {
      this.flushSequence();
    }
    this.draw();
    this.rafId = requestAnimationFrame(this._loop);
  }

  dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  computeEAR(lm, idx) {
    const p1 = lm[idx[0]];
    const p2 = lm[idx[1]];
    const p3 = lm[idx[2]];
    const p4 = lm[idx[3]];
    const p5 = lm[idx[4]];
    const p6 = lm[idx[5]];
    return (this.dist(p2, p6) + this.dist(p3, p5)) / (2 * this.dist(p1, p4));
  }

  smoothedEAR(raw) {
    this.earHistory.push(raw);
    if (this.earHistory.length > this.earSmoothing) this.earHistory.shift();
    let sum = 0;
    for (let i = 0; i < this.earHistory.length; i++) sum += this.earHistory[i];
    return sum / this.earHistory.length;
  }

  processFrame() {
    const faces = this.results && this.results.faceLandmarks;
    const lm = faces && faces[0];
    if (!lm) {
      this.hasFace = false;
      if (this.isClosed) {
        this.isClosed = false;
        this.closedAt = 0;
      }
      this.onState("noface");
      if (this.calibrating) {
        this.onCalibration({ phase: "calibrating", progress: this.calibSamples.length / 45, noFace: true });
      }
      return;
    }
    this.hasFace = true;
    const rawEar = (this.computeEAR(lm, this.LEFT_EYE) + this.computeEAR(lm, this.RIGHT_EYE)) / 2;
    this.ear = this.smoothedEAR(rawEar);

    // calibration: collect open-eye samples (EAR > 0.18 to avoid collecting blinks)
    if (this.calibrating) {
      if (rawEar > 0.18) this.calibSamples.push(rawEar);
      const progress = Math.min(1, this.calibSamples.length / 45);
      this.onCalibration({ phase: "calibrating", progress: progress, ear: this.ear });
      if (this.calibSamples.length >= 45) {
        this.finishCalibration();
      } else if (this.calibSamples.length > 10 && performance.now() % 3000 < 16) {
        // also auto-finish after ~2.5s even if not 45 samples — check via time
      }
      // hard timeout: finish 2.8s after start regardless
      if (!this._calibTimer) {
        this._calibTimer = setTimeout(() => {
          if (this.calibrating) this.finishCalibration();
          this._calibTimer = null;
        }, 2800);
      }
      this.onState("calibrating");
      return;
    }

    const now = performance.now();
    // hysteresis with smoothed EAR, require stable transition
    if (!this.isClosed && this.ear < this.CLOSED_THRESHOLD) {
      this.isClosed = true;
      this.closedAt = now;
      this.onState("closed");
    } else if (this.isClosed && this.ear > this.OPEN_THRESHOLD) {
      const startedAt = this.closedAt;
      const duration = now - startedAt;
      this.isClosed = false;
      this.closedAt = 0;
      this.onState("open");
      if (duration >= this.MIN_BLINK_MS && duration <= this.DASH_MAX_MS) {
        const symbol = duration <= this.DOT_MAX_MS ? "." : "-";
        const gap = this.lastClosedEnd ? startedAt - this.lastClosedEnd : Infinity;
        if (gap <= this.SEQUENCE_GAP_MS && this.seqCount > 0) {
          this.seqCount += 1;
        } else {
          this.flushSequence();
          this.seqCount = 1;
          this.seqFirstChar = symbol;
        }
        this.lastClosedEnd = now;
      }
    } else {
      this.onState(this.isClosed ? "closed" : "open");
    }
  }

  flushSequence() {
    if (!this.seqCount) return;
    if (this.seqCount === 1) {
      this.onSymbol(this.seqFirstChar);
    } else if (this.seqCount === 2) {
      this.onSeparator("letter");
    } else {
      this.onSeparator("word");
    }
    this.seqCount = 0;
    this.seqFirstChar = "";
  }

  draw() {
    // no eye contours — status is shown via side icon (HTML), canvas kept clear
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVisibility);
    if (this._calibTimer) {
      clearTimeout(this._calibTimer);
      this._calibTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.landmarker) {
      try { this.landmarker.close(); } catch (_e) {}
      // keep instance for faster restart but closed, so null it to allow re-create
      this.landmarker = null;
    }
    this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hasFace = false;
    this.isClosed = false;
    this.closedAt = 0;
    this.lastClosedEnd = 0;
    this.seqCount = 0;
    this.seqFirstChar = "";
    this.lastVideoTime = -1;
    this.earHistory = [];
    this.ear = 0;
    this.calibrating = false;
    this.calibSamples = [];
    this.calibDone = false;
  }
}
