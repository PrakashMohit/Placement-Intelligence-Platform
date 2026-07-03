-- ============================================================
-- IIT Madras Placement Intelligence — Supabase Schema
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor)
-- Safe to run multiple times — drops existing policies first
-- ============================================================

-- 1. User profiles
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  roll_number TEXT,
  department TEXT,
  graduation_year INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Interviews
CREATE TABLE IF NOT EXISTS interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  level TEXT NOT NULL,
  focus TEXT,
  company TEXT,
  question_count INT DEFAULT 5,
  current_index INT DEFAULT 1,
  current_question TEXT,
  status TEXT DEFAULT 'active',
  average_score NUMERIC(4,1),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Per-turn answers
CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID REFERENCES interviews(id) ON DELETE CASCADE,
  question_number INT,
  question TEXT,
  transcript TEXT,
  score INT,
  feedback TEXT,
  strengths JSONB DEFAULT '[]'::jsonb,
  improvements JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE answers    ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first (safe re-run)
DROP POLICY IF EXISTS "Users own their profile"    ON profiles;
DROP POLICY IF EXISTS "Users own their interviews" ON interviews;
DROP POLICY IF EXISTS "Users own their answers"    ON answers;

-- Recreate policies
CREATE POLICY "Users own their profile"
  ON profiles FOR ALL
  USING (auth.uid() = id);

CREATE POLICY "Users own their interviews"
  ON interviews FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Users own their answers"
  ON answers FOR ALL
  USING (
    interview_id IN (
      SELECT id FROM interviews WHERE user_id = auth.uid()
    )
  );

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_interviews_user_id   ON interviews(user_id);
CREATE INDEX IF NOT EXISTS idx_interviews_status    ON interviews(status);
CREATE INDEX IF NOT EXISTS idx_answers_interview_id ON answers(interview_id);
