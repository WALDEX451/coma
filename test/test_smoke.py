"""Smoke tests for the committed COMA server and browser assets."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from server import App


class ComaSmokeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = App(("127.0.0.1", 0), self.directory.name, rate_limits=False)
        self.thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.app.server_port}"

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.thread.join(timeout=5)
        self.app.db.close()
        self.directory.cleanup()

    def request(self, path, method="GET", body=None, cookie=None, csrf=None):
        headers = {}
        if method != "GET":
            headers.update({"Origin": self.base, "Content-Type": "application/json"})
            if csrf:
                headers["X-CSRF-Token"] = csrf
        if cookie:
            headers["Cookie"] = cookie
        data = json.dumps(body or {}).encode() if method != "GET" else None
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            content = response.read()
            return response.status, response.headers, json.loads(content) if path.startswith("/api/") else content

    def test_assets_and_private_conversation(self):
        for path in ("/", "/app.js", "/styles.css", "/favicon.svg"):
            status, _, content = self.request(path)
            self.assertEqual(status, 200, path)
            self.assertTrue(content, path)
        status, _, session = self.request("/api/session")
        self.assertEqual(status, 200)
        self.assertTrue(session["setup"])

        status, headers, first = self.request("/api/register", "POST", {
            "name": "First User", "username": "first", "password": "long-password-123"
        })
        self.assertEqual(status, 201)
        first_cookie = headers["Set-Cookie"].split(";", 1)[0]
        first_csrf = first["csrf"]
        self.assertTrue(first["user"]["admin"])

        status, _, denied = self.request("/api/register", "POST", {
            "name": "Second User", "username": "second", "password": "long-password-456"
        })
        self.assertEqual(status, 403)
        self.assertIn("invitation", denied["error"])

        status, _, invite = self.request("/api/invites", "POST", {}, first_cookie, first_csrf)
        self.assertEqual(status, 201)
        status, headers, second = self.request("/api/register", "POST", {
            "name": "Second User", "username": "second", "password": "long-password-456", "invite": invite["token"]
        })
        self.assertEqual(status, 201)
        second_cookie = headers["Set-Cookie"].split(";", 1)[0]
        conversation_id = second["conversationId"]

        status, _, conversations = self.request("/api/conversations", cookie=first_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(conversations["conversations"][0]["id"], conversation_id)

        status, _, message = self.request(
            f"/api/conversations/{conversation_id}/messages", "POST",
            {"body": "Hello from COMA", "clientId": str(uuid.uuid4())}, first_cookie, first_csrf
        )
        self.assertEqual(status, 201)
        status, _, messages = self.request(
            f"/api/conversations/{conversation_id}/messages", cookie=second_cookie
        )
        self.assertEqual(status, 200)
        self.assertEqual(messages["messages"][0]["body"], "Hello from COMA")
        self.assertEqual(messages["messages"][0]["id"], message["message"]["id"])

        status, _, forbidden = self.request(
            f"/api/conversations/{conversation_id}/messages", "POST",
            {"body": "Bad CSRF", "clientId": str(uuid.uuid4())}, second_cookie
        )
        self.assertEqual(status, 403)
        self.assertIn("session", forbidden["error"])


if __name__ == "__main__":
    unittest.main()
