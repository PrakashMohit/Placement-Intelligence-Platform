const $ = (selector) => document.querySelector(selector);
let interview, recorder, micStream, audioContext, analyser, meterFrame, recognition;
let chunks = [], isRecording = false, isMuted = false, isSpeaking = false;
let finalTranscript = "", recognitionRestartTimer = null;

// ─── Utility ────────────────────────────────────────────────────────────────

function showError(message = "", room = false) {
  $(room ? "#error" : "#prejoin-error").textContent = message;
}

async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error("Cannot reach the server. Check that the Flask app is running."); }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

// ─── Microphone / Level Meter ────────────────────────────────────────────────

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
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    const width = Math.min(100, Math.max(2, average * 1.8));
    $("#meter-bar").style.width = `${width}%`;
    $("#room-meter span").style.width = `${width}%`;
    $("#candidate-tile").classList.toggle("speaking", average > 12 && !isMuted);
    meterFrame = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(meterFrame);
  draw();
}

// ─── Mic check / Pre-join ────────────────────────────────────────────────────

$("#check-mic").addEventListener("click", async () => {
  showError();
  $("#check-mic").disabled = true;
  $("#mic-message").textContent = "Requesting microphone…";
  try {
    await getMicrophone();
    $("#preview-mic-state").textContent = "Microphone ready";
    $("#preview-mic-state").classList.add("good");
    $("#mic-message").textContent = "Speak now — the green bar should move.";
    $("#check-mic").textContent = "Microphone checked";
    $("#join-button").disabled = false;
  } catch {
    $("#mic-message").textContent = "Microphone access was blocked.";
    showError("Allow microphone access in your browser, then try again.");
    $("#check-mic").disabled = false;
  }
});

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError();
  const button = $("#join-button");
  button.disabled = true;
  button.textContent = "Joining…";
  try {
    await getMicrophone();
    interview = await api("/api/interviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: $("#role").value,
        level: $("#level").value,
        focus: $("#focus").value,
        question_count: Number($("#question-count").value),
      }),
    });
    $("#prejoin").classList.add("hidden");
    $("#interview").classList.remove("hidden");
    // Conversational start: greet first, then ask the first question
    await startInterviewConversation(interview);
  } catch (error) {
    showError(error.message);
    button.disabled = false;
    button.textContent = "Join interview";
  }
});

// ─── Conversational Interview Flow ──────────────────────────────────────────

async function startInterviewConversation(iv) {
  updateProgress();
  setTranscriptPlaceholder();
  lockControls(true);

  // Show the question text in the panel immediately
  $("#question").textContent = iv.current_question;

  // Speak the entire opening as ONE continuous natural speech —
  // greeting, small talk, format intro, and first question all flow together
  // with no clip-switching seams. Falls back to just the question if absent.
  const openingSpeech = iv.full_opening || iv.current_question;
  await speak(openingSpeech);

  lockControls(false);
}

async function showQuestion(question, transition = "") {
  interview.current_question = question;
  $("#question").textContent = question;
  updateProgress();
  setTranscriptPlaceholder();
  lockControls(true);

  // Speak transition + question as one natural utterance
  const spoken = transition ? `${transition} ${question}` : question;
  await speak(spoken);

  lockControls(false);
}

function updateProgress() {
  $("#progress-text").textContent = `Question ${interview.current_index} of ${interview.question_count}`;
  $("#status").textContent = "Ready";
}

function setTranscriptPlaceholder() {
  $("#final-transcript").textContent = "";
  $("#interim-transcript").textContent = "";
  $(".caption-block").classList.remove("listening");
}

// Prevent answering while AI is speaking
function lockControls(lock) {
  $("#record").disabled = lock;
  $("#repeat").disabled = lock;
  isSpeaking = lock;
}

// ─── TTS (OpenAI via backend) ────────────────────────────────────────────────

async function speak(text) {
  $("#ai-speaking").classList.remove("hidden");
  $(".ai-tile").classList.add("speaking");
  return new Promise(async (resolve) => {
    try {
      const audioBlob = await api("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        stopAiSpeaking();
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        stopAiSpeaking();
        speakInBrowser(text, resolve);
      };
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
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = "en-IN";
  speech.rate = 0.95;
  speech.onend = onDone;
  speech.onerror = onDone;
  window.speechSynthesis.speak(speech);
}

function stopAiSpeaking() {
  $("#ai-speaking").classList.add("hidden");
  $(".ai-tile").classList.remove("speaking");
}

// ─── Live Transcript (SpeechRecognition) ────────────────────────────────────

function startLiveCaptions() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  finalTranscript = "";
  $("#final-transcript").textContent = "";
  $("#interim-transcript").textContent = "Listening…";

  if (!Recognition) {
    $("#final-transcript").textContent =
      "Live captions are not supported in this browser. Your recorded answer will still be transcribed after submission.";
    $("#interim-transcript").textContent = "";
    return;
  }

  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  // Use Indian English for better accuracy with Indian accents
  // Falls back gracefully to en-US in browsers that don't support en-IN
  recognition.lang = "en-IN";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      // Pick the highest-confidence alternative
      let bestAlt = event.results[i][0];
      for (let j = 1; j < event.results[i].length; j++) {
        if (event.results[i][j].confidence > bestAlt.confidence) {
          bestAlt = event.results[i][j];
        }
      }
      if (event.results[i].isFinal) {
        finalTranscript += bestAlt.transcript + " ";
      } else {
        interim += bestAlt.transcript;
      }
    }
    $("#final-transcript").textContent = finalTranscript;
    $("#interim-transcript").textContent = interim;
  };

  recognition.onerror = (e) => {
    // Ignore 'no-speech' errors — they just mean silence, not a real problem
    if (e.error === "no-speech") return;
    // For other errors, attempt a restart
    scheduleRecognitionRestart();
  };

  recognition.onend = () => {
    // If still recording, restart recognition automatically
    if (isRecording && !isMuted) {
      scheduleRecognitionRestart();
    }
  };

  try {
    recognition.start();
  } catch {
    // Already started — ignore
  }
}

function scheduleRecognitionRestart() {
  // Debounce restarts to avoid rapid-fire loops
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = setTimeout(() => {
    if (!isRecording || isMuted || !recognition) return;
    try { recognition.start(); } catch {}
  }, 350);
}

function stopLiveCaptions() {
  clearTimeout(recognitionRestartTimer);
  if (!recognition) return;
  recognition.onend = null;
  recognition.onerror = null;
  recognition.onresult = null;
  try { recognition.stop(); } catch {}
  recognition = null;
}

// ─── Recording Controls ──────────────────────────────────────────────────────

$("#record").addEventListener("click", async () => {
  showError("", true);
  if (isSpeaking) return; // Don't allow recording while AI is speaking
  if (isRecording) return stopAnswer();
  try {
    await getMicrophone();
    if (isMuted) toggleMute();
    chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    recorder = new MediaRecorder(micStream, { mimeType });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = submitRecording;
    recorder.start(250);
    isRecording = true;
    startLiveCaptions();
    $("#record").classList.add("recording");
    $("#record span:last-child").textContent = "Submit";
    $("#status").textContent = "Recording";
    $(".caption-block").classList.add("listening");
    $("#repeat").disabled = true;
  } catch {
    showError("Microphone is unavailable. Check browser permission and try again.", true);
  }
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
  $(".caption-block").classList.remove("listening");
  $("#interim-transcript").textContent = "";
}

async function submitRecording() {
  const form = new FormData();
  form.append("audio", new Blob(chunks, { type: recorder.mimeType }), "answer.webm");
  try {
    const result = await api(`/api/interviews/${interview.id}/answers`, { method: "POST", body: form });
    const answer = result.answer;

    // Show final whisper transcript (server-side, more accurate)
    $("#final-transcript").textContent = answer.transcript;
    $("#interim-transcript").textContent = "";

    // Show feedback card
    $("#feedback").innerHTML = `<strong>${answer.score}/10</strong><p>${escapeHtml(answer.feedback)}</p>`;
    $("#feedback").classList.remove("hidden");

    if (result.completed) {
      // Speak warm closing before showing the results screen
      if (result.closing) {
        lockControls(true);
        $("#status").textContent = "Wrapping up…";
        await speak(result.closing);
      }
      await showResults();
    } else {
      interview.current_index += 1;
      // Pass the conversational transition along to showQuestion
      await showQuestion(result.next_question, result.transition || "");
    }
  } catch (error) {
    showError(error.message, true);
    $("#status").textContent = "Ready";
    $("#record").disabled = false;
    $("#repeat").disabled = false;
  }
}

// ─── Mute ────────────────────────────────────────────────────────────────────

function toggleMute() {
  isMuted = !isMuted;
  micStream?.getAudioTracks().forEach((track) => { track.enabled = !isMuted; });
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

// ─── Results ─────────────────────────────────────────────────────────────────

async function showResults() {
  stopMedia();
  const data = await api(`/api/interviews/${interview.id}/results`);
  $("#interview").classList.add("hidden");
  $("#results").classList.remove("hidden");
  $("#final-score").textContent = data.answers.length
    ? `Average score: ${data.average_score}/10`
    : "Interview ended";
  $("#answer-list").innerHTML = data.answers
    .map(
      (answer) => `
    <article><h3>${answer.question_number}. ${escapeHtml(answer.question)}</h3>
    <p><b>Your answer:</b> ${escapeHtml(answer.transcript)}</p>
    <p><b>Feedback:</b> ${escapeHtml(answer.feedback)}</p><span>${answer.score}/10</span></article>
  `
    )
    .join("");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stopMedia() {
  stopLiveCaptions();
  window.speechSynthesis?.cancel();
  micStream?.getTracks().forEach((track) => track.stop());
  cancelAnimationFrame(meterFrame);
  audioContext?.close();
}

function escapeHtml(text) {
  const element = document.createElement("div");
  element.textContent = text;
  return element.innerHTML;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

$("#restart").addEventListener("click", () => window.location.reload());
window.addEventListener("beforeunload", stopMedia);
