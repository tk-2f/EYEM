(function () {
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  const camToggle = document.getElementById("camToggle");
  const statusPill = document.getElementById("statusPill");
  const calibBar = document.getElementById("calibBar");
  const calibFill = document.getElementById("calibFill");
  const calibText = document.getElementById("calibText");
  const eyeIndicator = document.getElementById("eyeIndicator");
  const morseBox = document.getElementById("morseBox");
  const textBox = document.getElementById("textBox");
  const resetBtn = document.getElementById("resetBtn");
  const tableBtn = document.getElementById("tableBtn");
  const tableWrap = document.getElementById("tableWrap");
  const morseGrid = document.getElementById("morseGrid");
  const morseGridDigits = document.getElementById("morseGridDigits");
  const aboutBtn = document.getElementById("aboutBtn");
  const aboutModal = document.getElementById("aboutModal");
  const aboutClose = document.getElementById("aboutClose");
  const toastEl = document.getElementById("toast");

  let engine = null;
  let cameraOn = false;
  let syncing = false;
  let lastMorse = "";
  let lastText = "";
  let glowTimer = 0;
  let toastTimer = 0;

  // light button click sound (Web Audio, no files)
  let audioCtx = null;
  let morseMuted = localStorage.getItem("eyem_morse_muted") === "1";
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function clickSound() {
    try {
      const ctx = ensureAudio();
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(900, t0);
      osc.frequency.exponentialRampToValueAtTime(600, t0 + 0.06);
      gain.gain.setValueAtTime(0.14, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.09);
    } catch (_e) {}
  }
  function morseBeep(sym) {
    if (morseMuted) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
      const ctx = ensureAudio();
      const t0 = ctx.currentTime;
      const dur = sym === "-" ? 0.24 : 0.08;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(700, t0);
      gain.gain.setValueAtTime(0.18, t0);
      gain.gain.setValueAtTime(0.18, t0 + dur - 0.015);
      gain.gain.linearRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (_e) {}
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.disabled) return;
    clickSound();
  }, true);

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  function setStatus(text) {
    if (text === "Open" || text === "Closed") {
      statusPill.hidden = true;
      statusPill.textContent = "";
      statusPill.classList.remove("alert", "calibrating");
      return;
    }
    statusPill.hidden = false;
    statusPill.textContent = text;
    statusPill.classList.toggle("calibrating", text === "Calibrating");
  }

  function writeBoth(morse, text) {
    syncing = true;
    morseBox.value = morse;
    textBox.value = text;
    syncing = false;
  }

  function setMorse(morse, textOverride) {
    lastMorse = morse;
    lastText = textOverride !== undefined ? textOverride : decodeMorse(morse);
    writeBoth(morse, lastText);
    const live = document.getElementById("morseLive");
    if (live) live.textContent = lastText ? lastText + " — " + (morse || "empty") : "empty";
  }

  function flashGlow() {
    morseBox.classList.add("glow-active");
    clearTimeout(glowTimer);
    glowTimer = setTimeout(() => morseBox.classList.remove("glow-active"), 350);
  }

  function appendSymbol(sym) {
    setMorse(lastMorse + sym);
    morseBeep(sym);
    flashGlow();
  }

  function insertSeparator(kind) {
    if (kind === "letter") {
      if (!lastMorse || /\s$/.test(lastMorse)) return;
      setMorse(lastMorse + " ");
    } else {
      const value = lastMorse.trimEnd();
      if (!value || value.endsWith("/")) return;
      setMorse(value + " / ");
    }
    flashGlow();
  }

  const STATE_LABELS = {
    model: "Loading model",
    calibrating: "Calibrating",
    closed: "Closed",
    open: "Open",
    noface: "No face"
  };

  function setEye(state) {
    eyeIndicator.className = "eye-indicator is-" + state;
  }

  function handleState(state) {
    setStatus(STATE_LABELS[state] || "Detecting");
    if (state === "closed") setEye("closed");
    else if (state === "open") setEye("open");
    else if (state === "noface") setEye("noface");
    else if (state === "calibrating") setEye("calibrating");
    else if (state === "model") setEye("calibrating");
  }

  function handleCalibration(ev) {
    if (ev.phase === "calibrating") {
      calibBar.hidden = false;
      calibText.hidden = false;
      const pct = Math.round((ev.progress || 0) * 100);
      calibFill.style.height = pct + "%";
      if (ev.noFace) {
        calibText.textContent = "No face — center your face";
      } else {
        calibText.textContent = "Calibrating " + pct + "% — keep eyes open";
      }
      setStatus("Calibrating");
      setEye("calibrating");
    } else if (ev.phase === "done") {
      calibFill.style.height = "100%";
      if (ev.fallback) {
        calibText.textContent = "Calibration skipped";
        toast("Calibration had no face data — using defaults.");
      } else {
        calibText.textContent = "Calibrated";
        toast("Calibrated — thresholds set.");
      }
      setTimeout(() => { calibBar.hidden = true; calibText.hidden = true; calibFill.style.height = "0%"; }, 1000);
      setStatus("Open");
      setEye("open");
    }
  }

  function warnLocked(e, el) {
    if (!cameraOn) return false;
    if (e && e.cancelable) e.preventDefault();
    el.blur();
    toast("Camera is on — turn it off before typing.");
    return true;
  }

  function guardElement(el) {
    ["mousedown", "touchstart", "keydown", "paste", "drop"].forEach((evName) =>
      el.addEventListener(evName, (e) => warnLocked(e, el))
    );
    el.addEventListener("focus", () => {
      if (cameraOn) warnLocked(null, el);
    });
  }

  guardElement(morseBox);
  guardElement(textBox);

  morseBox.addEventListener("input", () => {
    if (warnLocked(null, morseBox)) {
      writeBoth(lastMorse, lastText);
      return;
    }
    if (syncing) return;
    setMorse(normalizeMorse(morseBox.value));
  });

  textBox.addEventListener("input", () => {
    if (warnLocked(null, textBox)) {
      writeBoth(lastMorse, lastText);
      return;
    }
    if (syncing) return;
    const text = textBox.value;
    lastText = text;
    lastMorse = encodeMorse(text);
    syncing = true;
    morseBox.value = lastMorse;
    syncing = false;
  });

  function describeError(err) {
    const msg = err && err.message ? err.message : "";
    if (msg && msg.indexOf("MediaPipe") !== -1) return msg;
    if (msg && msg.indexOf("CDN") !== -1) return msg;
    if (err && err.name === "NotAllowedError") return "Camera permission was denied.";
    if (err && err.name === "NotFoundError") return "No camera device was found.";
    if (err && err.name === "NotReadableError") return "Camera is busy in another app.";
    if (msg) return msg;
    return "Could not start eye tracking. Check connection and permissions.";
  }

  async function startCamera() {
    camToggle.disabled = true;
    camToggle.textContent = "Starting...";
    statusPill.hidden = false;
    statusPill.textContent = "Starting";
    try {
      if (!engine) engine = new BlinkEngine(video, overlay);
      await engine.start({
        onSymbol: appendSymbol,
        onState: handleState,
        onSeparator: insertSeparator,
        onCalibration: handleCalibration
      });
      cameraOn = true;
      document.body.classList.add("camera-live");
      camToggle.textContent = "Stop Camera";
      camToggle.classList.add("is-on");
      morseBox.readOnly = true;
      textBox.readOnly = true;
      morseBox.classList.add("locked");
      textBox.classList.add("locked");
      morseBox.blur();
      textBox.blur();
    } catch (err) {
      console.error(err);
      setStatus("Off");
      calibBar.hidden = true;
      calibText.hidden = true;
      setEye("open");
      if (engine) engine.stop();
      toast(describeError(err));
    } finally {
      camToggle.disabled = false;
    }
  }

  function stopCamera() {
    if (engine) engine.stop();
    cameraOn = false;
    document.body.classList.remove("camera-live");
    camToggle.textContent = "Start Camera";
    camToggle.classList.remove("is-on");
    morseBox.readOnly = false;
    textBox.readOnly = false;
    morseBox.classList.remove("locked");
    textBox.classList.remove("locked");
    calibBar.hidden = true;
    calibText.hidden = true;
    calibFill.style.height = "0%";
    setEye("open");
    setStatus("Off");
  }

  camToggle.addEventListener("click", () => {
    if (camToggle.disabled) return;
    if (cameraOn) stopCamera();
    else startCamera();
  });

  function doReset() {
    setMorse("");
    toast("Cleared — blink again to start.");
  }
  resetBtn.addEventListener("click", doReset);

  function deleteLastSymbol() {
    if (!lastMorse) { toast("Nothing to delete."); return; }
    let m = lastMorse;
    if (m.endsWith(" / ")) m = m.slice(0, -3);
    else if (m.endsWith(" ")) m = m.slice(0, -1);
    else m = m.slice(0, -1);
    setMorse(m);
    toast("Deleted last symbol.");
  }

  // keyboard shortcuts: R=reset(while cam on), C=camera, M=mic, F=delete last
  function isTypingField() {
    const el = document.activeElement;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (aboutModal && aboutModal.open) return;
    const k = e.key.toLowerCase();

    // R — reset, only outside typing fields (so you can type r normally)
    if (k === "r") {
      if (isTypingField()) return;
      e.preventDefault();
      doReset();
      return;
    }
    // F — delete last morse symbol (works anytime, but not while typing English)
    if (k === "f") {
      if (isTypingField() && !cameraOn) return;
      if (!lastMorse) return;
      e.preventDefault();
      deleteLastSymbol();
      return;
    }
    // C — toggle camera
    if (k === "c") {
      if (isTypingField() && !cameraOn) return;
      e.preventDefault();
      if (camToggle.disabled) return;
      if (cameraOn) stopCamera(); else startCamera();
      return;
    }
    // M — toggle mic (voice) — opens and closes, only outside text fields
    if (k === "m") {
      if (listening) {
        e.preventDefault();
        try { getRecognition().stop(); } catch (_e) {}
        return;
      }
      if (isTypingField()) return;
      e.preventDefault();
      if (cameraOn) { toast("Camera is on — turn it off before using voice."); return; }
      if (voiceBtn) voiceBtn.click();
      else {
        const rec = getRecognition();
        if (!rec) { toast("Voice not supported in this browser. Use Chrome/Edge."); return; }
        try { rec.start(); } catch (_e) { toast("Could not start voice — try again"); }
      }
      return;
    }
  }, true);

  tableBtn.addEventListener("click", () => {
    const willShow = tableWrap.hidden;
    tableWrap.hidden = !willShow;
    tableBtn.textContent = willShow ? "Hide Translation Table" : "Show Translation Table";
    tableBtn.setAttribute("aria-expanded", String(willShow));
    if (willShow) tableWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // copy buttons
  function copyFrom(id, btn) {
    const el = document.getElementById(id);
    const val = el ? el.value : "";
    if (!val) { toast("Nothing to copy."); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(() => {
        toast("Copied!");
        btn.classList.add("copied");
        const old = btn.innerHTML;
        btn.innerHTML = 'Copied';
        setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = old; }, 1200);
      }).catch(() => fallbackCopy(el, btn));
    } else {
      fallbackCopy(el, btn);
    }
  }
  function fallbackCopy(el, btn) {
    el.focus(); el.select();
    try { document.execCommand("copy"); toast("Copied!"); } catch (_e) { toast("Copy failed."); }
  }
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => copyFrom(btn.getAttribute("data-copy"), btn));
  });

  // voice to morse — mic icon inside Translation box (bottom right)
  const voiceBtn = document.getElementById("voiceBtn");
  let recognition = null;
  let listening = false;

  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    if (recognition) return recognition;
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;
    recognition.onstart = () => {
      listening = true;
      voiceBtn.classList.add("listening");
      voiceBtn.querySelector(".voice-label").textContent = "Listening";
      toast("Listening — speak now");
    };
    recognition.onend = () => {
      listening = false;
      voiceBtn.classList.remove("listening");
      voiceBtn.querySelector(".voice-label").textContent = "Voice";
    };
    recognition.onerror = (e) => {
      listening = false;
      voiceBtn.classList.remove("listening");
      voiceBtn.querySelector(".voice-label").textContent = "Voice";
      let msg = "Voice failed";
      if (e.error === "not-allowed") msg = "Microphone permission denied";
      else if (e.error === "no-speech") msg = "No speech detected";
      else if (e.error) msg = "Voice error: " + e.error;
      toast(msg);
    };
    recognition.onresult = (ev) => {
      const transcript = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
      if (!transcript) { toast("No speech recognized"); return; }
      const clean = transcript.trim();
      if (!clean) return;
      // if camera is on, don't allow typing via voice (same as locked)
      if (cameraOn) { toast("Camera is on — turn it off before using voice."); return; }
      // fill Translation box and auto-convert to morse
      lastText = clean;
      lastMorse = encodeMorse(clean);
      writeBoth(lastMorse, lastText);
      flashGlow();
      toast('Heard: "' + clean + '"');
    };
    return recognition;
  }

  if (voiceBtn) {
    voiceBtn.addEventListener("click", () => {
      if (cameraOn) { toast("Camera is on — turn it off before using voice."); return; }
      const rec = getRecognition();
      if (!rec) { toast("Voice not supported in this browser. Use Chrome/Edge."); return; }
      if (listening) {
        try { rec.stop(); } catch (_e) {}
        return;
      }
      try { rec.start(); } catch (_e) { toast("Could not start voice — try again"); }
    });
  }

  aboutBtn.addEventListener("click", () => aboutModal.showModal());
  aboutClose.addEventListener("click", () => aboutModal.close());
  aboutModal.addEventListener("click", (e) => {
    if (e.target === aboutModal) aboutModal.close();
  });
  // a11y: focus trap + Esc + return focus
  let lastFocus = null;
  aboutModal.addEventListener("close", () => {
    document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  });
  const origShowModal = aboutBtn.onclick;
  aboutBtn.addEventListener("click", () => {
    lastFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    setTimeout(() => aboutClose.focus(), 0);
  });
  aboutModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); aboutModal.close(); }
    if (e.key !== "Tab") return;
    const focusable = aboutModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // sound mute toggle — now inside morse box (custom icon)
  const soundBtn = document.getElementById("morseSoundBtn");
  function syncSoundBtn() {
    if (!soundBtn) return;
    soundBtn.setAttribute("aria-pressed", String(morseMuted));
    soundBtn.title = morseMuted ? "Morse beep off — click to enable" : "Morse beep on — click to mute";
    soundBtn.setAttribute("aria-label", morseMuted ? "Morse sound off — click to turn on" : "Morse sound on — click to mute");
    const label = soundBtn.querySelector(".sound-label");
    if (label) label.textContent = morseMuted ? "Off" : "Sound";
  }
  syncSoundBtn();
  if (soundBtn) soundBtn.addEventListener("click", () => {
    morseMuted = !morseMuted;
    localStorage.setItem("eyem_morse_muted", morseMuted ? "1" : "0");
    syncSoundBtn();
    toast(morseMuted ? "Morse sound off" : "Morse sound on");
  });

  function buildTable() {
    const letters = document.createDocumentFragment();
    const digits = document.createDocumentFragment();
    const punct = document.createDocumentFragment();
    // create punct section if not exists — we add it dynamically under table
    Object.keys(MORSE_ALPHABET).forEach((key) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      const ltr = document.createElement("span");
      ltr.className = "ltr";
      ltr.textContent = key;
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = MORSE_ALPHABET[key];
      cell.append(ltr, code);
      if (/[A-Z]/.test(key)) letters.append(cell);
      else if (/[0-9]/.test(key)) digits.append(cell);
      else punct.append(cell);
    });
    morseGrid.append(letters);
    morseGridDigits.append(digits);
    // add punctuation column dynamically if needed
    if (punct.childNodes.length) {
      const tableColumns = document.querySelector(".table-columns");
      if (tableColumns) {
        const col = document.createElement("div");
        col.className = "table-col table-col-punct";
        col.setAttribute("data-col", "");
        const btn = document.createElement("button");
        btn.className = "table-toggle";
        btn.setAttribute("aria-expanded", "true");
        btn.setAttribute("aria-controls", "morseGridPunct");
        btn.innerHTML = '<span>Punctuation</span><svg class="toggle-arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const grid = document.createElement("div");
        grid.className = "morse-grid";
        grid.id = "morseGridPunct";
        grid.append(punct);
        col.append(btn, grid);
        tableColumns.append(col);
      }
    }
  }

  function initToggles() {
    document.querySelectorAll(".table-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
      });
    });
  }

  buildTable();
  initToggles();
  // re-init after dynamic punct added (delegated already, but ensure)
  document.querySelectorAll(".table-toggle").forEach((btn) => {
    if (!btn._bound) { btn._bound = true; }
  });
  // Quick Start banner — shows 30s, hover shows X to close
  (function () {
    const qs = document.getElementById("quickStart");
    const qc = document.getElementById("quickClose");
    if (!qs) return;
    let timer = null;
    function hideQS() {
      qs.classList.remove("show");
      setTimeout(() => { qs.hidden = true; }, 300);
      if (timer) { clearTimeout(timer); timer = null; }
    }
    function showQS() {
      qs.hidden = false;
      // force reflow then animate
      void qs.offsetWidth;
      qs.classList.add("show");
      timer = setTimeout(hideQS, 30000);
    }
    if (qc) qc.addEventListener("click", hideQS);
    // show after 10s
    setTimeout(showQS, 10000);
  })();
  setMorse("");
})();
