-- ============================================================
-- IIT Madras Placement Intelligence — Supabase Schema
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor)
-- Safe to run multiple times — drops existing policies first
-- ============================================================

-- 1. User profiles
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  email TEXT,
  roll_number TEXT,
  department TEXT,
  graduation_year INT,
  profile_photo_url TEXT,
  resume_url TEXT,
  resume_filename TEXT,
  skills JSONB DEFAULT '[]'::jsonb,
  target_roles JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_filename TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]'::jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS target_roles JSONB DEFAULT '[]'::jsonb;

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
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users own their interviews"
  ON interviews FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users own their answers"
  ON answers FOR ALL
  USING (
    interview_id IN (
      SELECT id FROM interviews WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    interview_id IN (
      SELECT id FROM interviews WHERE user_id = auth.uid()
    )
  );

-- Keep auth.users and public.profiles in sync for new signups.
-- This prevents users from landing in auth.users without a matching profile row.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    roll_number,
    department,
    graduation_year
  )
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'roll_number',
    NEW.raw_user_meta_data->>'department',
    NULLIF(NEW.raw_user_meta_data->>'graduation_year', '')::INT
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
    roll_number = COALESCE(EXCLUDED.roll_number, profiles.roll_number),
    department = COALESCE(EXCLUDED.department, profiles.department),
    graduation_year = COALESCE(EXCLUDED.graduation_year, profiles.graduation_year);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_interviews_user_id   ON interviews(user_id);
CREATE INDEX IF NOT EXISTS idx_interviews_status    ON interviews(status);
CREATE INDEX IF NOT EXISTS idx_answers_interview_id ON answers(interview_id);
