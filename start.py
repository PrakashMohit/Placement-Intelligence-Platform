import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    has_request_context,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from openai import OpenAI
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from supabase import create_client, Client
from werkzeug.utils import secure_filename


# ── Paths & Config ─────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "bluebook_data.json"
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
PROFILE_PHOTO_DIR = UPLOAD_DIR / "profile_photos"
RESUME_DIR = UPLOAD_DIR / "resumes"

load_dotenv(BASE_DIR / ".env", override=True)

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-change-me-in-production")
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024

# ── Clients ────────────────────────────────────────────────────────────────────

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
# Support both SUPABASE_KEY (publishable/anon) and SUPABASE_ANON_KEY
SUPABASE_KEY = (
    os.getenv("SUPABASE_KEY")
    or os.getenv("SUPABASE_ANON_KEY")
    or SUPABASE_SERVICE_ROLE_KEY
    or ""
)

supabase: Client = None
supabase_admin: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"[DB] Supabase connected: {SUPABASE_URL}")
    except Exception as _sb_err:
        print(f"[DB] Supabase init FAILED: {_sb_err}")
else:
    print(f"[DB] Supabase NOT configured — URL={SUPABASE_URL!r}, KEY={'set' if SUPABASE_KEY else 'MISSING'}")

if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    try:
        supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        print("[DB] Supabase service-role client available for server-side writes")
    except Exception as _sb_admin_err:
        print(f"[DB] Supabase service-role init FAILED: {_sb_admin_err}")

openai_client = OpenAI(timeout=45, max_retries=1) if os.getenv("OPENAI_API_KEY") else None


whisper_model = None
parakeet_model = None

# ── Constants ──────────────────────────────────────────────────────────────────

MAX_QUESTIONS = 10
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
DEFAULT_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "nova")

DEPARTMENTS = [
    "Data Science",
    "Electronics Systems",
    "Aeronautics",
    "Data Science with Management",
]

SKILL_OPTIONS = [
    "Python",
    "SQL",
    "Machine Learning",
    "Data Structures",
    "System Design",
    "Communication",
    "Product Thinking",
    "Cloud",
]

TARGET_ROLE_OPTIONS = [
    "Software Engineer",
    "Data Scientist",
    "ML Engineer",
    "Data Analyst",
    "Product Analyst",
    "Backend Engineer",
    "Frontend Engineer",
    "Consultant",
]

ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg"}
ALLOWED_RESUME_EXTENSIONS = {"pdf"}
MAX_PROFILE_ASSET_BYTES = 1 * 1024 * 1024
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "profile-assets")
ALLOWED_PHOTO_MIMES = {"image/jpeg"}
ALLOWED_RESUME_MIMES = {"application/pdf"}


# ══════════════════════════════════════════════════════════════════════════════
# BLUEBOOK HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def load_companies():
    with DATA_FILE.open("r", encoding="utf-8") as f:
        return json.load(f)["companies"]


def find_question(companies, question_id):
    for company in companies:
        for rnd in company["rounds"]:
            for topic in rnd["topics"]:
                for subtopic in topic["subtopics"]:
                    for question in subtopic["questions"]:
                        if question["id"] == question_id:
                            return company, rnd, topic, subtopic, question
    return None


def get_company_context(company_name: str) -> dict:
    for company in load_companies():
        if company["name"].lower() == company_name.lower():
            topics, sample_questions = [], []
            for rnd in company.get("rounds", []):
                for topic in rnd.get("topics", []):
                    topics.append(topic["name"])
                    for subtopic in topic.get("subtopics", []):
                        for q in subtopic.get("questions", [])[:2]:
                            sample_questions.append(q["text"])
            return {
                "name": company["name"],
                "domain": company.get("domain", ""),
                "topics": list(set(topics))[:8],
                "sample_questions": sample_questions[:12],
            }
    return {}


def fallback_similar_questions(question, company_name, round_name, subtopic_name):
    base = question["text"].rstrip("?")
    return [
        {"question": f"{base}, but explain your approach before writing code.", "difficulty": question.get("difficulty", "Medium"), "focus": "Communication and structured problem solving"},
        {"question": f"How would you solve a variation of this for a larger input size at {company_name} scale?", "difficulty": "Medium", "focus": "Complexity analysis and optimization"},
        {"question": f"In a {round_name.lower()} round, what edge cases would you test for this {subtopic_name.lower()} problem?", "difficulty": "Easy", "focus": "Testing and edge cases"},
    ]


def extract_output_text(payload):
    if payload.get("output_text"):
        return payload["output_text"]
    parts = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(content["text"])
    return "\n".join(parts)


def generate_with_openai(context):
    import urllib.error, urllib.request
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    prompt = (
        "Generate interview practice questions similar to the given original question. "
        "Do not repeat the original question. Keep them company-relevant, round-relevant, "
        "and suitable for campus placement preparation. Return only valid JSON with a "
        "'questions' array. Each item must contain 'question', 'difficulty', and 'focus'.\n\n"
        f"Company: {context['company']}\nRound: {context['round']}\n"
        f"Topic: {context['topic']}\nSubtopic: {context['subtopic']}\n"
        f"Original question: {context['question']}"
    )
    payload = {
        "model": model,
        "input": prompt,
        "text": {"format": {"type": "json_schema", "name": "similar_interview_questions", "strict": True,
            "schema": {"type": "object", "additionalProperties": False,
                "properties": {"questions": {"type": "array", "minItems": 3, "maxItems": 5,
                    "items": {"type": "object", "additionalProperties": False,
                        "properties": {"question": {"type": "string"}, "difficulty": {"type": "string"}, "focus": {"type": "string"}},
                        "required": ["question", "difficulty", "focus"]}}},
                "required": ["questions"]}}},
    }
    try:
        req = urllib.request.Request("https://api.openai.com/v1/responses",
            data=json.dumps(payload).encode(), method="POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return json.loads(extract_output_text(data)).get("questions", [])
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# AI INTERVIEW HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def clean_text(value, limit):
    return " ".join(str(value or "").split())[:limit]


def clean_list(values, options, limit=12, item_limit=80):
    if not isinstance(values, list):
        return []

    cleaned, seen = [], set()
    for value in values:
        item = clean_text(value, item_limit)
        if not item:
            continue
        if item.lower() == "other":
            continue
        key = item.lower()
        if key in seen:
            continue
        if item in options or item:
            cleaned.append(item)
            seen.add(key)
        if len(cleaned) >= limit:
            break
    return cleaned


def profile_payload(profile, user):
    profile = profile or {}
    return {
        "id": user["id"],
        "email": profile.get("email") or user.get("email", ""),
        "full_name": profile.get("full_name") or user.get("full_name", ""),
        "roll_number": profile.get("roll_number") or user.get("roll_number", ""),
        "department": profile.get("department") or user.get("department", ""),
        "graduation_year": profile.get("graduation_year") or user.get("graduation_year"),
        "profile_photo_url": profile.get("profile_photo_url") or user.get("profile_photo_url", ""),
        "resume_url": profile.get("resume_url") or "",
        "resume_filename": profile.get("resume_filename") or "",
        "skills": profile.get("skills") or [],
        "target_roles": profile.get("target_roles") or [],
    }


def allowed_file(filename, allowed_extensions):
    if "." not in filename:
        return False
    return filename.rsplit(".", 1)[1].lower() in allowed_extensions


def save_profile_upload(upload, folder, allowed_extensions, allowed_mimes, user_id):
    if not upload or not upload.filename:
        return None, None
    filename = secure_filename(upload.filename)
    if not allowed_file(filename, allowed_extensions):
        raise ValueError("Unsupported file type.")
    upload.seek(0, os.SEEK_END)
    size = upload.tell()
    upload.seek(0)
    if size > MAX_PROFILE_ASSET_BYTES:
        raise ValueError("File must be 1 MB or smaller.")
    if allowed_mimes and upload.mimetype not in allowed_mimes:
        raise ValueError("Unsupported file type.")

    storage_client = supabase_admin or get_supabase_db_client()
    if not storage_client:
        raise RuntimeError("Storage is not configured.")

    ext = filename.rsplit(".", 1)[1].lower()
    stored_name = f"{folder}/{user_id}/{uuid.uuid4().hex}.{ext}"
    file_options = {
        "content-type": upload.mimetype,
        "upsert": "true",
    }
    storage_client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
        stored_name,
        upload.read(),
        file_options,
    )
    public_url = storage_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(stored_name)
    return public_url, filename


def require_openai():
    if not openai_client:
        raise RuntimeError("OPENAI_API_KEY is not configured.")


class InterviewOpening(BaseModel):
    full_opening: str = Field(
        description=(
            "A single, continuous, naturally flowing opening speech — exactly as a real human interviewer "
            "would actually talk. Include: (1) a casual warm greeting, (2) a brief ice-breaker comment, "
            "(3) a casual format intro mentioning role, level, and question count, "
            "(4) a natural transition into the first question. "
            "Write as ONE flowing piece of spoken dialogue. Use contractions. Sound like a real person talking."
            "Start by asking their name and short intro before moving to the first question."
        )
    )
    question: str = Field(description="The first interview question text only — for UI display.")


class TurnEvaluation(BaseModel):
    score: int = Field(ge=0, le=10)
    feedback: str = Field(description="Specific feedback in two short sentences.")
    strengths: list[str] = Field(max_length=3)
    improvements: list[str] = Field(max_length=3)
    transition: str = Field(description="Natural 1-2 sentence bridge acknowledging the answer and leading to next question. Empty if last question.")
    next_question: str = Field(description="The next interview question, or empty string if finished.")
    closing: str = Field(default="", description="Only for LAST question: warm 2-sentence closing. Empty for all other turns.")


def build_company_context_prompt(company_name: str) -> str:
    ctx = get_company_context(company_name)
    if not ctx:
        return ""
    topics_str = ", ".join(ctx["topics"][:6]) if ctx["topics"] else "general topics"
    samples_str = "\n".join(f"- {q}" for q in ctx["sample_questions"][:6])
    return (
        f"\n\nCOMPANY CONTEXT — {ctx['name']} ({ctx['domain']}):\n"
        f"Common topics: {topics_str}\n"
        f"Sample real questions:\n{samples_str}\n"
        f"Generate SIMILAR IN STYLE and TOPIC questions — fresh variations, not identical."
    )


def generate_opening(role, level, focus, company=""):
    require_openai()
    company_prompt = build_company_context_prompt(company) if company else ""
    resp = openai_client.responses.parse(
        model=DEFAULT_MODEL,
        input=[
            {"role": "developer", "content": (
                "You are a warm, energetic, professional female interviewer having a real conversation. "
                "Generate a natural opening monologue that flows like a human would actually speak — "
                "not stiff, not robotic. The full_opening must be ONE continuous piece of speech. "
                "Use contractions, casual connectors, vary sentence length."
                + (f" This interview is for {company} — make it company-relevant." if company else "")
            )},
            {"role": "user", "content": (
                f"Role: {role}\nLevel: {level}\nFocus: {focus or 'general role skills'}\n"
                + (f"Company: {company}\n" if company else "")
                + company_prompt
            )},
        ],
        text_format=InterviewOpening,
    )
    return resp.output_parsed


def evaluate_answer(interview, answer, is_last, prev_answers):
    require_openai()
    brief_history = "\n".join(f"Q: {a['question']}\nA: {a['transcript']}" for a in prev_answers[-3:])
    company = interview.get("company") or ""
    company_prompt = build_company_context_prompt(company) if company and not is_last else ""
    resp = openai_client.responses.parse(
        model=DEFAULT_MODEL,
        input=[
            {"role": "developer", "content": (
                "You are a warm, natural, conversational female interviewer. "
                "Score honestly, generate a natural TRANSITION — not formal, like a real human reacting. "
                "Use contractions, casual connectors. Next question must be concise and not repeat earlier ones. "
                "Last turn: transition and next_question are empty, closing is warm 2-3 sentence wrap-up. "
                "Non-last turns: closing is empty string."
            )},
            {"role": "user", "content": (
                f"Role: {interview['role']}\nLevel: {interview['level']}\n"
                f"Focus: {interview.get('focus') or 'general'}\n"
                + (f"Company: {company}\n" if company else "")
                + f"Current question: {interview['current_question']}\n"
                f"Candidate answer: {answer}\nLast turn: {is_last}\n"
                f"Recent history:\n{brief_history or 'None'}" + company_prompt
            )},
        ],
        text_format=TurnEvaluation,
    )
    return resp.output_parsed


def get_whisper_model():
    global whisper_model
    if whisper_model is None:
        from faster_whisper import WhisperModel
        whisper_model = WhisperModel(
            os.getenv("WHISPER_MODEL", "small.en"),
            # device="cuda",  
            # compute_type="float16",
            device="cpu", compute_type="int8",    # for deploy only on vercel
            cpu_threads=int(os.getenv("WHISPER_CPU_THREADS", "2")),
        )
    return whisper_model



# import av

# def convert_audio_to_wav(input_path, output_path, target_rate=16000):
#     resampler = av.audio.resampler.AudioResampler(
#         format="s16",
#         layout="mono",
#         rate=target_rate,
#     )

#     with av.open(input_path) as input_container:
#         in_stream = input_container.streams.audio[0]

#         with av.open(output_path, "w") as output_container:
#             out_stream = output_container.add_stream(
#                 "pcm_s16le",
#                 rate=target_rate,
#             )

#             for packet in input_container.demux(in_stream):
#                 for frame in packet.decode():
#                     frame.pts = None

#                     for new_frame in resampler.resample(frame):
#                         for packet in out_stream.encode(new_frame):
#                             output_container.mux(packet)

#             for packet in out_stream.encode():
#                 output_container.mux(packet)



def transcribe(upload):
    suffix = Path(upload.filename or "answer.webm").suffix or ".webm"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            upload.save(tmp)
            temp_path = tmp.name

        backend = os.getenv("STT_BACKEND", "whisper").strip().lower()
        # if backend == "parakeet":
        #     return transcribe_with_parakeet(temp_path)

        segments, _ = get_whisper_model().transcribe(
            temp_path, beam_size=5, vad_filter=True,
            language=os.getenv("WHISPER_LANGUAGE", "en"),
            condition_on_previous_text=False, temperature=0.0,
        )
        return " ".join(s.text.strip() for s in segments).strip()
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# AUTH HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def get_current_user():
    return session.get("user")


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not get_current_user():
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required."}), 401
            return redirect(url_for("auth_page"))
        return f(*args, **kwargs)
    return decorated


def supabase_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not supabase:
            return jsonify({"error": "Database not configured."}), 503
        return f(*args, **kwargs)
    return decorated


# ══════════════════════════════════════════════════════════════════════════════
# SUPABASE DB HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def get_supabase_db_client():
    if supabase_admin:
        return supabase_admin

    token = session.get("supabase_access_token") if has_request_context() else None
    if not token:
        return supabase

    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    client.postgrest.auth(token)
    return client


def db_table(name):
    return get_supabase_db_client().table(name)


def get_auth_access_token(auth_response):
    auth_session = getattr(auth_response, "session", None)
    if not auth_session:
        return None
    if isinstance(auth_session, dict):
        return auth_session.get("access_token")
    return getattr(auth_session, "access_token", None)


def has_db_write_authority():
    if supabase_admin:
        return True
    return bool(session.get("supabase_access_token")) if has_request_context() else False


def db_authority_error():
    return jsonify({
        "error": (
            "Your login session needs to be refreshed before saving. "
            "Please log out and sign in again, or configure SUPABASE_SERVICE_ROLE_KEY for server-side database writes."
        )
    }), 401


def db_create_interview(data):
    return db_table("interviews").insert(data).execute().data[0]


def db_get_interview(interview_id):
    r = db_table("interviews").select("*").eq("id", interview_id).execute()
    return r.data[0] if r.data else None


def db_update_interview(interview_id, updates):
    db_table("interviews").update(updates).eq("id", interview_id).execute()


def db_add_answer(data):
    return db_table("answers").insert(data).execute().data[0]


def db_list_answers(interview_id):
    return db_table("answers").select("*").eq("interview_id", interview_id).order("question_number").execute().data or []


def db_list_user_interviews(user_id):
    return db_table("interviews").select("*").eq("user_id", user_id).order("created_at", desc=True).limit(20).execute().data or []


def db_get_profile(user_id):
    r = db_table("profiles").select("*").eq("id", user_id).execute()
    return r.data[0] if r.data else None


def db_upsert_profile(data):
    r = db_table("profiles").upsert(data, on_conflict="id").execute()
    return r.data[0] if r.data else data


def parse_graduation_year(value):
    if value in (None, ""):
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        raise ValueError("Graduation year must be a valid year.")
    if year < 2024 or year > 2030:
        raise ValueError("Graduation year must be between 2024 and 2030.")
    return year


def optional_graduation_year(value):
    try:
        return parse_graduation_year(value)
    except ValueError:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# PAGE ROUTES — all protected except / , /auth, /auth/callback, /health
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    # Landing page — visible to all, but nav shows login state
    return render_template("index.html", user=get_current_user())


@app.route("/auth")
def auth_page():
    if get_current_user():
        return redirect(url_for("dashboard"))
    return render_template("auth.html")


@app.route("/auth/callback")
def auth_callback():
    return render_template("auth_callback.html")


@app.route("/dashboard")
@login_required
def dashboard():
    user = get_current_user()
    interviews = []
    if supabase:
        try:
            interviews = db_list_user_interviews(user["id"])
        except Exception:
            pass
    return render_template("dashboard_v2.html", user=user, interviews=interviews)


@app.route("/profile")
@login_required
def profile_page():
    user = get_current_user()
    try:
        profile = db_get_profile(user["id"]) if supabase and has_db_write_authority() else {}
    except Exception:
        profile = {}
    current_profile = profile_payload(profile, user)
    return render_template(
        "profile.html",
        user=current_profile,
        skill_options=SKILL_OPTIONS,
        target_role_options=TARGET_ROLE_OPTIONS,
    )


@app.route("/questions")
@login_required
def questions_page():
    return render_template("questions.html", user=get_current_user())


@app.route("/interview/new")
@login_required
def interview_new():
    return render_template("interview_setup.html", user=get_current_user())


@app.route("/interview/practice")
@login_required
def interview_practice():
    companies = load_companies()
    company_list = sorted(
        [{"id": c["id"], "name": c["name"], "domain": c.get("domain", "")} for c in companies],
        key=lambda x: x["name"],
    )
    return render_template("interview_practice.html", user=get_current_user(), companies=company_list)


@app.route("/interview/room")
@login_required
def interview_room():
    return render_template("interview_room.html", user=get_current_user())


@app.route("/interview/results/<interview_id>")
@login_required
def interview_results_page(interview_id):
    return render_template("interview_results.html", user=get_current_user(), interview_id=interview_id)


# ══════════════════════════════════════════════════════════════════════════════
# AUTH API
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/auth/register")
@supabase_required
def api_register():
    data = request.get_json(silent=True) or {}
    email = clean_text(data.get("email"), 200)
    password = data.get("password", "")
    full_name = clean_text(data.get("full_name"), 100)
    roll_number = clean_text(data.get("roll_number"), 20)
    department = clean_text(data.get("department"), 80)
    graduation_year = data.get("graduation_year")

    if not email or not password or not full_name:
        return jsonify({"error": "Name, email and password are required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    if department and department not in DEPARTMENTS:
        return jsonify({"error": "Invalid department selected."}), 400
    try:
        graduation_year = parse_graduation_year(graduation_year)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        profile_data = {
            "id": "",
            "email": email,
            "full_name": full_name,
            "roll_number": roll_number,
            "department": department,
            "graduation_year": graduation_year,
        }
        auth_response = supabase.auth.sign_up({
            "email": email,
            "password": password,
            "options": {
                "data": {
                    "full_name": full_name,
                    "roll_number": roll_number,
                    "department": department,
                    "graduation_year": str(graduation_year or ""),
                }
            },
        })
        if not auth_response.user:
            return jsonify({"error": "Registration failed. Please try again."}), 400

        user_id = auth_response.user.id
        access_token = get_auth_access_token(auth_response)
        if access_token:
            session["supabase_access_token"] = access_token
        profile_data["id"] = user_id
        try:
            db_upsert_profile(profile_data)
        except Exception as profile_exc:
            app.logger.warning("Profile upsert failed after signup; ensure schema.sql trigger is applied: %s", profile_exc)

        session["user"] = {
            "id": user_id, "email": email, "full_name": full_name,
            "roll_number": roll_number, "department": department,
            "graduation_year": graduation_year,
        }
        return jsonify({"message": "Registration successful.", "redirect": url_for("dashboard")}), 201
    except Exception as exc:
        msg = str(exc)
        if "already registered" in msg.lower() or "already exists" in msg.lower():
            return jsonify({"error": "An account with this email already exists."}), 409
        if "rate limit" in msg.lower() or "too many requests" in msg.lower():
            return jsonify({"error": "Signup rate limit reached. Please wait a few minutes and try again."}), 429
        app.logger.exception("Registration error")
        return jsonify({"error": "Registration failed. Please try again."}), 500


@app.post("/api/auth/login")
@supabase_required
def api_login():
    data = request.get_json(silent=True) or {}
    email = clean_text(data.get("email"), 200)
    password = data.get("password", "")
    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    try:
        auth_resp = supabase.auth.sign_in_with_password({"email": email, "password": password})
        if not auth_resp.user:
            return jsonify({"error": "Invalid email or password."}), 401
        user_id = auth_resp.user.id
        access_token = get_auth_access_token(auth_resp)
        if access_token:
            session["supabase_access_token"] = access_token
        profile = db_get_profile(user_id)
        if not profile:
            metadata = getattr(auth_resp.user, "user_metadata", None) or {}
            fallback_profile = {
                "id": user_id,
                "email": email,
                "full_name": clean_text(metadata.get("full_name") or email.split("@")[0], 100),
                "roll_number": clean_text(metadata.get("roll_number"), 20),
                "department": clean_text(metadata.get("department"), 80),
                "graduation_year": optional_graduation_year(metadata.get("graduation_year")),
            }
            try:
                profile = db_upsert_profile(fallback_profile)
            except Exception as profile_exc:
                app.logger.warning("Could not repair missing profile row on login: %s", profile_exc)
                profile = fallback_profile
        session["user"] = {
            "id": user_id, "email": email,
            "full_name": profile.get("full_name", email.split("@")[0]) if profile else email.split("@")[0],
            "roll_number": profile.get("roll_number", "") if profile else "",
            "department": profile.get("department", "") if profile else "",
            "graduation_year": profile.get("graduation_year") if profile else None,
            "profile_photo_url": profile.get("profile_photo_url", "") if profile else "",
        }
        return jsonify({"message": "Login successful.", "redirect": url_for("dashboard")})
    except Exception as exc:
        msg = str(exc)
        if "invalid" in msg.lower() or "credentials" in msg.lower():
            return jsonify({"error": "Invalid email or password."}), 401
        app.logger.exception("Login error")
        return jsonify({"error": "Login failed. Please try again."}), 500


@app.post("/api/auth/logout")
def api_logout():
    session.clear()
    if supabase:
        try:
            supabase.auth.sign_out()
        except Exception:
            pass
    return jsonify({"redirect": url_for("index")})


@app.get("/api/auth/me")
def api_me():
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    return jsonify(user)


@app.get("/api/profile")
@login_required
@supabase_required
def api_get_profile():
    user = get_current_user()
    profile = db_get_profile(user["id"])
    return jsonify(profile_payload(profile, user))


@app.post("/api/profile")
@login_required
@supabase_required
def api_update_profile():
    user = get_current_user()
    if not has_db_write_authority():
        return db_authority_error()

    existing = db_get_profile(user["id"]) or {}

    try:
        skills = json.loads(request.form.get("skills", "[]"))
        target_roles = json.loads(request.form.get("target_roles", "[]"))
    except json.JSONDecodeError:
        return jsonify({"error": "Skills and target roles must be valid lists."}), 400

    updates = {
        "id": user["id"],
        "email": existing.get("email") or user.get("email", ""),
        "full_name": existing.get("full_name") or user.get("full_name", ""),
        "roll_number": existing.get("roll_number") or user.get("roll_number", ""),
        "department": existing.get("department") or user.get("department", ""),
        "graduation_year": existing.get("graduation_year") or user.get("graduation_year"),
        "skills": clean_list(skills, SKILL_OPTIONS),
        "target_roles": clean_list(target_roles, TARGET_ROLE_OPTIONS),
    }

    try:
        photo_url, _photo_filename = save_profile_upload(
            request.files.get("profile_photo"),
            "profile_photos",
            ALLOWED_PHOTO_EXTENSIONS,
            ALLOWED_PHOTO_MIMES,
            user["id"],
        )
    except ValueError as exc:
        return jsonify({"error": f"Profile photo: {exc} Use a JPEG file up to 1 MB."}), 400
    if photo_url:
        updates["profile_photo_url"] = photo_url

    try:
        resume_url, resume_filename = save_profile_upload(
            request.files.get("resume"),
            "resumes",
            ALLOWED_RESUME_EXTENSIONS,
            ALLOWED_RESUME_MIMES,
            user["id"],
        )
    except ValueError as exc:
        return jsonify({"error": f"Resume: {exc} Use a PDF file up to 1 MB."}), 400
    if resume_url:
        updates["resume_url"] = resume_url
        updates["resume_filename"] = resume_filename

    try:
        profile = db_upsert_profile(updates)
        session["user"] = {
            **user,
            "email": profile.get("email") or user.get("email", ""),
            "full_name": profile.get("full_name") or user.get("full_name", ""),
            "roll_number": profile.get("roll_number") or user.get("roll_number", ""),
            "department": profile.get("department") or user.get("department", ""),
            "graduation_year": profile.get("graduation_year"),
            "profile_photo_url": profile.get("profile_photo_url", ""),
        }
        return jsonify(profile_payload(profile, session["user"]))
    except Exception as exc:
        app.logger.exception("Profile update failed")
        return jsonify({"error": "Could not save profile. Please check the profiles table policies and try again."}), 500


@app.get("/api/auth/google-url")
@supabase_required
def api_google_url():
    try:
        redirect_uri = os.getenv("OAUTH_REDIRECT_URL", request.host_url.rstrip("/") + "/auth/callback")
        result = supabase.auth.sign_in_with_oauth({
            "provider": "google",
            "options": {"redirect_to": redirect_uri},
        })
        return jsonify({"url": result.url})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# INTERVIEW API
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/interviews")
@login_required
def api_start_interview():
    data = request.get_json(silent=True) or {}
    role = clean_text(data.get("role"), 80)
    level = clean_text(data.get("level"), 30)
    focus = clean_text(data.get("focus"), 200)
    company = clean_text(data.get("company"), 100)
    question_count = min(max(int(data.get("question_count", 5)), 1), MAX_QUESTIONS)

    if not role or not level:
        return jsonify({"error": "Role and level are required."}), 400
    if supabase and not has_db_write_authority():
        return db_authority_error()

    try:
        opening = generate_opening(role, level, focus, company)
        user = get_current_user()
        interview_id = str(uuid.uuid4())
        interview_data = {
            "id": interview_id,
            "user_id": user["id"],
            "role": role, "level": level, "focus": focus,
            "company": company or None,
            "question_count": question_count,
            "current_index": 1,
            "current_question": opening.question,
            "status": "active",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        interview = db_create_interview(interview_data) if supabase else interview_data
        interview["full_opening"] = opening.full_opening
        return jsonify(interview), 201
    except Exception as exc:
        app.logger.exception("Could not start interview")
        return jsonify({"error": str(exc)}), 500


@app.post("/api/interviews/<interview_id>/answers")
@login_required
def api_submit_answer(interview_id):
    upload = request.files.get("audio")
    if not upload:
        return jsonify({"error": "Audio is required."}), 400
    if not supabase:
        return jsonify({"error": "Database not configured."}), 503

    try:
        interview = db_get_interview(interview_id)
        if not interview or interview.get("status") != "active":
            return jsonify({"error": "Active interview not found."}), 404
        if interview.get("user_id") != get_current_user()["id"]:
            return jsonify({"error": "Forbidden."}), 403

        transcript = transcribe(upload)
        if len(transcript) < 2:
            return jsonify({"error": "No clear speech detected. Please try again."}), 400

        is_last = interview["current_index"] >= interview["question_count"]
        prev_answers = db_list_answers(interview_id)
        evaluation = evaluate_answer(interview, transcript, is_last, prev_answers)

        answer_data = {
            "id": str(uuid.uuid4()),
            "interview_id": interview_id,
            "question_number": interview["current_index"],
            "question": interview["current_question"],
            "transcript": transcript,
            "score": evaluation.score,
            "feedback": evaluation.feedback,
            "strengths": evaluation.strengths,
            "improvements": evaluation.improvements,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        answer = db_add_answer(answer_data)
        db_update_interview(interview_id, {
            "current_index": interview["current_index"] + (0 if is_last else 1),
            "current_question": "" if is_last else evaluation.next_question,
            "status": "completed" if is_last else "active",
        })

        if is_last:
            all_answers = db_list_answers(interview_id)
            if all_answers:
                avg = round(sum(a["score"] for a in all_answers) / len(all_answers), 1)
                db_update_interview(interview_id, {"average_score": avg})

        return jsonify({
            "answer": answer,
            "transition": "" if is_last else evaluation.transition,
            "next_question": "" if is_last else evaluation.next_question,
            "closing": evaluation.closing if is_last else "",
            "completed": is_last,
        })
    except Exception as exc:
        app.logger.exception("Answer submission failed")
        return jsonify({"error": str(exc)}), 500


@app.get("/api/interviews/<interview_id>/results")
@login_required
def api_results(interview_id):
    if not supabase:
        return jsonify({"error": "Database not configured."}), 503
    interview = db_get_interview(interview_id)
    if not interview:
        return jsonify({"error": "Interview not found."}), 404
    if interview.get("user_id") != get_current_user()["id"]:
        return jsonify({"error": "Forbidden."}), 403
    answers = db_list_answers(interview_id)
    average = round(sum(a["score"] for a in answers) / len(answers), 1) if answers else 0
    return jsonify({"interview": interview, "answers": answers, "average_score": average})


@app.post("/api/speech")
@login_required
def api_speech():
    text = clean_text((request.get_json(silent=True) or {}).get("text"), 600)
    if not text:
        return jsonify({"error": "Text is required."}), 400
    require_openai()
    temp_path = Path(tempfile.gettempdir()) / f"{uuid.uuid4()}.mp3"
    voice_instructions = (
        "You are speaking as a professional female interviewer with a neutral Indian English accent."
        "Your voice is calm, confident, articulate, and welcoming."
        "Speak with excellent clarity and precise diction. Maintain a steady, moderate pace with natural pauses between sentences."
        "Sound professional, attentive, and respectful. Be encouraging without sounding overly enthusiastic."
        "Keep your tone neutral and unbiased, allowing candidates time to think. Avoid sounding robotic, monotone, overly emotional, or sales-oriented."
        "You are a real human interviewer — warm, energetic, professional, and genuinely engaged. "
        "This is NOT a text-to-speech reading. Speak exactly like a real person having an actual conversation. "
        "Vary your pace naturally. Let natural micro-pauses happen at commas and dashes. "
        "Sound genuinely curious and interested. Use a warm, slightly upbeat energy. "
        "On transition phrases like 'so', 'alright', 'now' — deliver them with a light, natural lilt. "
        "Do NOT sound like you are reading. Sound like you are TALKING."
    )
    try:
        with openai_client.audio.speech.with_streaming_response.create(
            model="gpt-4o-mini-tts", voice=DEFAULT_TTS_VOICE,
            input=text, instructions=voice_instructions, response_format="mp3",
        ) as tts_resp:
            tts_resp.stream_to_file(str(temp_path))
        resp = send_file(temp_path, mimetype="audio/mpeg", as_attachment=False)
        resp.call_on_close(lambda: temp_path.unlink(missing_ok=True))
        return resp
    except Exception as exc:
        temp_path.unlink(missing_ok=True)
        app.logger.exception("TTS error")
        return jsonify({"error": "TTS temporarily unavailable."}), 503


# ══════════════════════════════════════════════════════════════════════════════
# BLUEBOOK API (original adder routes — unchanged)
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/companies")
def api_companies():
    company_data = load_companies()
    query = request.args.get("q", "").strip().lower()
    if query:
        company_data = [c for c in company_data if
            query in c["name"].lower() or query in c.get("domain", "").lower()
            or any(query in t.lower() for t in c.get("tags", []))]
    return jsonify({"companies": company_data})


@app.get("/api/interview-companies")
def api_interview_companies():
    companies = load_companies()
    result = sorted([{"id": c["id"], "name": c["name"], "domain": c.get("domain", "")} for c in companies], key=lambda x: x["name"])
    return jsonify({"companies": result})


@app.post("/api/similar")
def api_similar_questions():
    payload = request.get_json(silent=True) or {}
    question_id = payload.get("question_id")
    if not question_id or not re.match(r"^[a-z0-9_-]+$", question_id):
        return jsonify({"error": "A valid question_id is required."}), 400
    result = find_question(load_companies(), question_id)
    if not result:
        return jsonify({"error": "Question not found."}), 404
    company, rnd, topic, subtopic, question = result
    context = {"company": company["name"], "round": rnd["name"], "topic": topic["name"], "subtopic": subtopic["name"], "question": question["text"]}
    generated = generate_with_openai(context)
    source = "openai" if generated else "starter"
    questions = generated or fallback_similar_questions(question, company["name"], rnd["name"], subtopic["name"])
    return jsonify({"source": source, "questions": questions})


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "Audio file too large. Keep answers under two minutes."}), 413


# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG") == "1")
