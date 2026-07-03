import io
import unittest
from unittest.mock import patch

import app as app_module


class AppTests(unittest.TestCase):
    def setUp(self):
        app_module.db = app_module.Database()
        self.client = app_module.app.test_client()

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})

    @patch("app.evaluate_answer")
    @patch("app.transcribe", return_value="I built a REST API.")
    @patch("app.generate_first_question", return_value="Tell me about a Flask API you built.")
    def test_interview_flow(self, _question, _transcribe, evaluate):
        evaluate.return_value = app_module.TurnEvaluation(
            score=8,
            feedback="Clear answer. Add measurable impact.",
            strengths=["Relevant"],
            improvements=["Add metrics"],
            next_question="",
        )
        started = self.client.post(
            "/api/interviews",
            json={"role": "Python Developer", "level": "Mid-level", "question_count": 1},
        )
        self.assertEqual(started.status_code, 201)
        interview = started.get_json()

        answered = self.client.post(
            f"/api/interviews/{interview['id']}/answers",
            data={"audio": (io.BytesIO(b"audio"), "answer.webm")},
            content_type="multipart/form-data",
        )
        self.assertEqual(answered.status_code, 200)
        self.assertTrue(answered.get_json()["completed"])

        results = self.client.get(f"/api/interviews/{interview['id']}/results")
        self.assertEqual(results.status_code, 200)
        self.assertEqual(results.get_json()["average_score"], 8.0)


if __name__ == "__main__":
    unittest.main()
