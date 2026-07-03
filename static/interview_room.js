// ── Interview Room JS (Adder-merged version) ─────────────────────────────────
// Reads interview from sessionStorage (set by setup pages) or URL param

const $ = (sel) => document.querySelector(sel);
let interview, recorder, micStream, audioContext, analyser, meterFrame, recognition;
let chunks = [], isRecording = false, isMuted = false, isSpeaking = false;
let finalTranscript = "", recognitionRestartTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function showError(msg = "") {
  $("#room-error").textContent = msg;
  if (msg) setTimeout(() => { $("#room-error").textContent = ""; }, 5000);
}

async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error("Cannot reach the server."); }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

// ── Mic / Level Meter ─────────────────────────────────────────────────────────

async function getMicrophone() {
  if (micStream?.active) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  startLevelMeter(micStream);
  return micStream;
}

function startLevelMeter(stream) {
  audioContext?.close();
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    const w = Math.min(100, Math.max(2, avg * 1.8));
    $("#room-meter span").style.width = `${w}%`;
    $("#candidate-tile").classList.toggle("speaking", avg > 12 && !isMuted);
    meterFrame = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(meterFrame);
  draw();
}

// ── Boot: load interview from sessionStorage ──────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  const stored = sessionStorage.getItem("currentInterview");
  const resumeId = sessionStorage.getItem("resumeInterviewId");

  if (resumeId && !stored) {
    // Resume flow: fetch interview state from server
    try {
      const data = await api(`/api/interviews/${resumeId}/results`);
      interview = data.interview;
      interview.full_opening = null; // no re-intro on resume
      sessionStorage.removeItem("resumeInterviewId");
      startRoom(false);
    } catch (err) {
      $("#question").textContent = "Could not load interview: " + err.message;
    }
    return;
  }

  if (!stored) {
    $("#question").textContent = "No interview found. Please go back and set one up.";
    return;
  }

  interview = JSON.parse(stored);
  sessionStorage.removeItem("currentInterview");

  try {
    await getMicrophone();
    await startRoom(true);
  } catch (err) {
    showError("Microphone blocked — " + err.message);
    $("#question").textContent = "Please allow microphone access and refresh.";
  }
});

async function startRoom(isNew) {
  updateProgress();
  setTranscriptPlaceholder();
  lockControls(true);
  $("#question").textContent = interview.current_question || "Loading…";

  if (isNew && interview.full_opening) {
    await speak(interview.full_opening);
  } else if (isNew && interview.current_question) {
    await speak(interview.current_question);
  }
  lockControls(false);
}

// ── Conversational Flow ───────────────────────────────────────────────────────

async function showNextQuestion(question, transition = "") {
  interview.current_question = question;
  $("#question").textContent = question;
  updateProgress();
  setTranscriptPlaceholder();
  lockControls(true);
  const spoken = transition ? `${transition} ${question}` : question;
  await speak(spoken);
  lockControls(false);
}

function updateProgress() {
  const idx = interview.current_index || 1;
  const total = interview.question_count || 5;
  $("#progress-text").textContent = `Question ${idx} of ${total}`;
  $("#status").textContent = "Ready";
}

function setTranscriptPlaceholder() {
  $("#final-transcript").textContent = "";
  $("#interim-transcript").textContent = "";
  $("#caption-block").classList.remove("listening");
}

function lockControls(lock) {
  $("#record").disabled = lock;
  $("#repeat").disabled = lock;
  isSpeaking = lock;
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function speak(text) {
  $("#ai-speaking").classList.remove("hidden");
  $(".ai-tile").classList.add("speaking");
  return new Promise(async (resolve) => {
    try {
      const blob = await api("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); stopAiSpeaking(); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); stopAiSpeaking(); speakInBrowser(text, resolve); };
      await audio.play();
    } catch {
      stopAiSpeaking();
      speakInBrowser(text, resolve);
    }
  });
}

function speakInBrowser(text, onDone = () => {}) {
  if (!("speechSynthesis" in window)) { onDone(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = "en-IN"; utt.rate = 0.95;
  utt.onend = onDone; utt.onerror = onDone;
  window.speechSynthesis.speak(utt);
}

function stopAiSpeaking() {
  $("#ai-speaking").classList.add("hidden");
  $(".ai-tile").classList.remove("speaking");
}

// ── Live Captions ─────────────────────────────────────────────────────────────

function startLiveCaptions() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  finalTranscript = "";
  $("#final-transcript").textContent = "";
  $("#interim-transcript").textContent = "Listening…";

  if (!Recognition) {
    $("#final-transcript").textContent = "Live captions not supported in this browser. Your recorded answer will still be transcribed.";
    $("#interim-transcript").textContent = "";
    return;
  }

  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognition.lang = "en-IN";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      let best = event.results[i][0];
      for (let j = 1; j < event.results[i].length; j++) {
        if (event.results[i][j].confidence > best.confidence) best = event.results[i][j];
      }
      if (event.results[i].isFinal) finalTranscript += best.transcript + " ";
      else interim += best.transcript;
    }
    $("#final-transcript").textContent = finalTranscript;
    $("#interim-transcript").textContent = interim;
  };

  recognition.onerror = (e) => { if (e.error !== "no-speech") scheduleRecognitionRestart(); };
  recognition.onend = () => { if (isRecording && !isMuted) scheduleRecognitionRestart(); };

  try { recognition.start(); } catch {}
}

function scheduleRecognitionRestart() {
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = setTimeout(() => {
    if (!isRecording || isMuted || !recognition) return;
    try { recognition.start(); } catch {}
  }, 350);
}

function stopLiveCaptions() {
  clearTimeout(recognitionRestartTimer);
  if (!recognition) return;
  recognition.onend = null; recognition.onerror = null; recognition.onresult = null;
  try { recognition.stop(); } catch {}
  recognition = null;
}

// ── Recording ─────────────────────────────────────────────────────────────────

$("#record").addEventListener("click", async () => {
  showError();
  if (isSpeaking) return;
  if (isRecording) return stopAnswer();
  try {
    await getMicrophone();
    if (isMuted) toggleMute();
    chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    recorder = new MediaRecorder(micStream, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = submitRecording;
    recorder.start(250);
    isRecording = true;
    startLiveCaptions();
    $("#record").classList.add("recording");
    $("#record span:last-child").textContent = "Submit";
    $("#status").textContent = "Recording";
    $("#caption-block").classList.add("listening");
    $("#repeat").disabled = true;
  } catch { showError("Microphone unavailable. Check browser permissions."); }
});

function stopAnswer() {
  if (!recorder || recorder.state === "inactive") return;
  isRecording = false;
  stopLiveCaptions();
  recorder.stop();
  $("#record").classList.remove("recording");
  $("#record span:last-child").textContent = "Answer";
  $("#record").disabled = true;
  $("#status").textContent = "Transcribing and evaluating…";
  $("#caption-block").classList.remove("listening");
  $("#interim-transcript").textContent = "";
}

async function submitRecording() {
  const form = new FormData();
  form.append("audio", new Blob(chunks, { type: recorder.mimeType }), "answer.webm");
  try {
    const result = await api(`/api/interviews/${interview.id}/answers`, { method: "POST", body: form });
    const answer = result.answer;

    // Show server-transcribed answer (Whisper, more accurate)
    $("#final-transcript").textContent = answer.transcript;
    $("#interim-transcript").textContent = "";

    // Show feedback
    $("#feedback").innerHTML = `<strong>${answer.score}/10</strong><p>${escapeHtml(answer.feedback)}</p>`;
    $("#feedback").classList.remove("hidden");

    if (result.completed) {
      if (result.closing) {
        lockControls(true);
        $("#status").textContent = "Wrapping up…";
        await speak(result.closing);
      }
      await showResults();
    } else {
      interview.current_index = (interview.current_index || 1) + 1;
      await showNextQuestion(result.next_question, result.transition || "");
    }
  } catch (err) {
    showError(err.message);
    $("#status").textContent = "Ready";
    $("#record").disabled = false;
    $("#repeat").disabled = false;
  }
}

// ── Mute ──────────────────────────────────────────────────────────────────────

function toggleMute() {
  isMuted = !isMuted;
  micStream?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  $("#mute").classList.toggle("muted", isMuted);
  $("#mute span:last-child").textContent = isMuted ? "Unmute" : "Mute";
  $("#muted-label").classList.toggle("hidden", !isMuted);
  if (isMuted) stopLiveCaptions();
  else if (isRecording) startLiveCaptions();
}

$("#mute").addEventListener("click", toggleMute);
$("#repeat").addEventListener("click", () => speak(interview.current_question));
$("#end").addEventListener("click", async () => {
  if (isRecording) {
    isRecording = false;
    stopLiveCaptions();
    recorder.onstop = null;
    recorder.stop();
  }
  await showResults();
});

// ── Results ───────────────────────────────────────────────────────────────────

async function showResults() {
  stopMedia();
  try {
    const data = await api(`/api/interviews/${interview.id}/results`);
    const overlay = $("#results-overlay");
    overlay.classList.remove("hidden");
    $("#final-score").textContent = data.answers.length
      ? `Average Score: ${data.average_score}/10`
      : "Interview Ended";
    $("#answer-list").innerHTML = data.answers.map(a => `
      <article>
        <h3>${a.question_number}. ${escapeHtml(a.question)}</h3>
        <p><strong>Your answer:</strong> ${escapeHtml(a.transcript)}</p>
        <p><strong>Feedback:</strong> ${escapeHtml(a.feedback)}</p>
        <span class="score-badge">${a.score}/10</span>
      </article>
    `).join("");
  } catch (err) {
    showError("Could not load results: " + err.message);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function stopMedia() {
  stopLiveCaptions();
  window.speechSynthesis?.cancel();
  micStream?.getTracks().forEach(t => t.stop());
  cancelAnimationFrame(meterFrame);
  audioContext?.close();
}

function escapeHtml(text) {
  const el = document.createElement("div");
  el.textContent = text;
  return el.innerHTML;
}

window.addEventListener("beforeunload", stopMedia);
