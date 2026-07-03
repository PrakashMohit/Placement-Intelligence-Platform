const $ = (selector) => document.querySelector(selector);

let interview = null;
let recorder = null;
let stream = null;
let chunks = [];
let isRecording = false;

function headers(json = false) {
  const value = {};
  if (json) value["Content-Type"] = "application/json";
  return value;
}

function showError(message = "") {
  $("#error").textContent = message;
}

function setBusy(busy, text = "Working…") {
  $("#status").textContent = busy ? text : "Ready";
  $("#record").disabled = busy;
  $("#repeat").disabled = busy;
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Cannot reach the server. Check that the Flask app is running.");
  }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function speak(text) {
  try {
    const audioBlob = await api("/api/speech", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ text }),
    });
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    speakInBrowser(text);
  }
}

function speakInBrowser(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = "en-US";
  speech.rate = 0.95;
  window.speechSynthesis.speak(speech);
}

function showQuestion(question) {
  interview.current_question = question;
  $("#question").textContent = question;
  $("#progress-text").textContent =
    `Question ${interview.current_index} of ${interview.question_count}`;
  setBusy(false);
  speak(question);
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    interview = await api("/api/interviews", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        role: $("#role").value,
        level: $("#level").value,
        focus: $("#focus").value,
        question_count: Number($("#question-count").value),
      }),
    });
    $("#setup").classList.add("hidden");
    $("#interview").classList.remove("hidden");
    showQuestion(interview.current_question);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Start interview";
  }
});

$("#record").addEventListener("click", async () => {
  showError();
  if (isRecording) {
    recorder.stop();
    isRecording = false;
    $("#record").textContent = "Start answering";
    setBusy(true, "Transcribing and evaluating…");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = submitRecording;
    recorder.start();
    isRecording = true;
    $("#record").textContent = "Stop and submit";
    $("#status").textContent = "Recording";
    $("#repeat").disabled = true;
  } catch (error) {
    showError("Microphone permission is required.");
  }
});

async function submitRecording() {
  stream.getTracks().forEach((track) => track.stop());
  const form = new FormData();
  form.append("audio", new Blob(chunks, { type: recorder.mimeType }), "answer.webm");

  try {
    const result = await api(`/api/interviews/${interview.id}/answers`, {
      method: "POST",
      headers: headers(),
      body: form,
    });
    const answer = result.answer;
    $("#feedback").innerHTML = `
      <strong>${answer.score}/10</strong>
      <p>${escapeHtml(answer.feedback)}</p>
    `;
    $("#feedback").classList.remove("hidden");
    if (result.completed) {
      await showResults();
    } else {
      interview.current_index += 1;
      showQuestion(result.next_question);
    }
  } catch (error) {
    showError(error.message);
    setBusy(false);
  }
}

async function showResults() {
  setBusy(true, "Loading results…");
  const data = await api(`/api/interviews/${interview.id}/results`, {
    headers: headers(),
  });
  $("#interview").classList.add("hidden");
  $("#results").classList.remove("hidden");
  $("#final-score").textContent = `Average score: ${data.average_score}/10`;
  $("#answer-list").innerHTML = data.answers.map((answer) => `
    <article>
      <h3>${answer.question_number}. ${escapeHtml(answer.question)}</h3>
      <p><b>Your answer:</b> ${escapeHtml(answer.transcript)}</p>
      <p><b>Feedback:</b> ${escapeHtml(answer.feedback)}</p>
      <span>${answer.score}/10</span>
    </article>
  `).join("");
}

function escapeHtml(text) {
  const element = document.createElement("div");
  element.textContent = text;
  return element.innerHTML;
}

$("#repeat").addEventListener("click", () => speak(interview.current_question));
$("#restart").addEventListener("click", () => window.location.reload());
