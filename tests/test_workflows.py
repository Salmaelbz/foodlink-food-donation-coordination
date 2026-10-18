import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_TEMP_ROOT = tempfile.TemporaryDirectory(prefix="foodlink-tests-")
os.environ["FOODLINK_DATABASE"] = str(Path(_TEMP_ROOT.name) / "module.sqlite3")

from app import create_app


class FoodLinkWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="foodlink-app-tests-")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        _TEMP_ROOT.cleanup()

    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret-key",
            "DATABASE": str(Path(self.temp.name) / f"{self._testMethodName}.sqlite3"),
            "DEMO_MODE": True,
            "SEED_DEMO": True,
            "PASSWORD_HASH_METHOD": "pbkdf2:sha256:1000",
        })
        self.client = self.app.test_client()

    def login(self, email, password="demo1234"):
        response = self.client.post("/api/login", json={"email": email, "password": password})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["csrf_token"]

    def post(self, path, csrf, data):
        return self.client.post(path, json=data, headers={"X-CSRF-Token": csrf})

    def patch(self, path, csrf, data):
        return self.client.patch(path, json=data, headers={"X-CSRF-Token": csrf})

    def test_role_scoping_and_csrf(self):
        csrf = self.login("partner@foodlink.local")
        bootstrap = self.client.get("/api/bootstrap").get_json()
        self.assertEqual({item["id"] for item in bootstrap["requests"]}, {"req-1", "req-3"})
        self.assertEqual(bootstrap["donations"], [])
        self.assertEqual(self.client.get("/api/matches").status_code, 403)
        self.assertEqual(self.client.post("/api/requests", json={}).status_code, 403)
        response = self.post("/api/requests", csrf, {
            "categories": ["Bakery"], "description": "Test request", "quantity": 1, "unit": "items",
            "destination": "Partner site", "required_by": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "submission_key": "request-submit-once",
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        duplicate = self.post("/api/requests", csrf, {
            "categories": ["Bakery"], "description": "Test request", "quantity": 1, "unit": "items",
            "destination": "Partner site", "required_by": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "submission_key": "request-submit-once",
        })
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.get_json()["duplicate"])
        self.assertEqual(duplicate.get_json()["id"], response.get_json()["id"])
        self.assertEqual(self.client.post("/api/logout", json={}).status_code, 403)

    def test_public_world_map_uses_bundled_sourced_country_data(self):
        hunger = self.client.get("/data/hunger-prevalence.json")
        geometry = self.client.get("/data/world-countries.svg")
        try:
            self.assertEqual(hunger.status_code, 200)
            self.assertEqual(geometry.status_code, 200)
            snapshot = hunger.get_json()
            self.assertEqual(snapshot["source"], "Food and Agriculture Organization of the United Nations (FAO), distributed by Our World in Data")
            self.assertRegex(snapshot["snapshot_date"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(any(country["iso3"] == "SOM" for country in snapshot["countries"]))
            self.assertIn("data-iso=\"SOM\"", geometry.get_data(as_text=True))
        finally:
            hunger.close()
            geometry.close()

    def test_end_to_end_match_delivery_discrepancy_and_issue_resolution(self):
        coordinator_csrf = self.login("coordinator@foodlink.local")
        suggestions = self.client.get("/api/matches").get_json()
        donation = next(item for item in suggestions["donations"] if item["id"] == "don-1")
        request = next(item for item in suggestions["requests"] if item["id"] == "req-1")
        pickup = datetime.fromisoformat(donation["pickup_from"])
        delivery_time = pickup + timedelta(hours=1)
        proposed = self.post("/api/matches", coordinator_csrf, {
            "donation_id": donation["id"], "request_id": request["id"], "quantity": 18, "unit": "items",
            "pickup": pickup.isoformat(), "delivery": delivery_time.isoformat(),
            "transport_feasible": True, "timing_feasible": True,
        })
        self.assertEqual(proposed.status_code, 201, proposed.get_json())
        match_id = proposed.get_json()["id"]

        for email in ("donor@foodlink.local", "partner@foodlink.local"):
            self.login(email)
            self.assertEqual(self.post(f"/api/matches/{match_id}/approval", self.client.get("/api/session").get_json()["csrf_token"],
                                       {"decision": "accepted"}).status_code, 200)

        self.login("coordinator@foodlink.local")
        coordinator_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        confirmation = self.post(f"/api/matches/{match_id}/confirm", coordinator_csrf, {"driver_id": "user-driver"})
        self.assertEqual(confirmation.status_code, 200, confirmation.get_json())
        delivery_id = confirmation.get_json()["delivery_id"]

        self.login("driver@foodlink.local")
        driver_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        for status, quantity in (("pickup_in_progress", None), ("collected", 18), ("in_transit", None)):
            payload = {"status": status}
            if quantity is not None:
                payload["quantity_collected"] = quantity
            self.assertEqual(self.patch(f"/api/deliveries/{delivery_id}/status", driver_csrf, payload).status_code, 200)

        self.login("partner@foodlink.local")
        partner_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        receipt = self.post(f"/api/deliveries/{delivery_id}/confirm", partner_csrf, {
            "quantity_received": 16, "condition_on_arrival": "Two items short; remaining food accepted.",
            "acceptance": "partially_accepted", "issue_category": "quantity_discrepancy",
        })
        self.assertEqual(receipt.status_code, 201, receipt.get_json())
        self.assertTrue(receipt.get_json()["discrepancy"])

        self.login("coordinator@foodlink.local")
        coordinator_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        issue = next(item for item in self.client.get("/api/bootstrap").get_json()["issues"] if item["delivery_id"] == delivery_id)
        updated = self.patch(f"/api/issues/{issue['id']}", coordinator_csrf, {
            "status": "resolved", "follow_up_action": "Driver and receiver reconciled the pickup count.",
        })
        self.assertEqual(updated.status_code, 200, updated.get_json())
        self.assertGreaterEqual(self.client.get(f"/api/deliveries/{delivery_id}/timeline").get_json()["timeline"].__len__(), 2)
        self.login("partner@foodlink.local")
        partner_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        correction = self.post(f"/api/deliveries/{delivery_id}/confirm", partner_csrf, {
            "quantity_received": 18, "condition_on_arrival": "Correction: pickup count was reconciled; all 18 items received.",
            "acceptance": "accepted", "is_correction": True,
        })
        self.assertEqual(correction.status_code, 201, correction.get_json())
        self.assertFalse(correction.get_json()["discrepancy"])
        connection = sqlite3.connect(self.app.config["DATABASE"])
        try:
            history = connection.execute(
                "SELECT correction_of FROM delivery_confirmations WHERE id=?",
                (correction.get_json()["confirmation_id"],),
            ).fetchone()
        finally:
            connection.close()
        self.assertIsNotNone(history[0])
        self.login("coordinator@foodlink.local")
        self.client.get("/api/session")
        report = self.client.get("/api/reports").get_json()
        self.assertGreaterEqual(report["confirmed_match_count"], 2)
        self.assertGreaterEqual(report["completion_count"], 1)
        self.assertEqual(report["missing_data"]["operational_effort"], "Coordinator hours and transport costs are not yet recorded.")
        self.assertIn("text/csv", self.client.get("/api/reports.csv").content_type)

    def test_confirmation_rechecks_allocations_and_cancellation_releases_them(self):
        coordinator_csrf = self.login("coordinator@foodlink.local")
        suggestions = self.client.get("/api/matches").get_json()
        donation = next(item for item in suggestions["donations"] if item["id"] == "don-1")
        request = next(item for item in suggestions["requests"] if item["id"] == "req-1")
        pickup = datetime.fromisoformat(donation["pickup_from"])
        delivery_time = pickup + timedelta(hours=1)
        def propose(quantity):
            response = self.post("/api/matches", coordinator_csrf, {
                "donation_id": donation["id"], "request_id": request["id"], "quantity": quantity,
                "pickup": pickup.isoformat(), "delivery": delivery_time.isoformat(),
                "transport_feasible": True, "timing_feasible": True,
            })
            self.assertEqual(response.status_code, 201, response.get_json())
            return response.get_json()["id"]

        first, second = propose(25), propose(6)
        for match_id in (first, second):
            for email in ("donor@foodlink.local", "partner@foodlink.local"):
                self.login(email)
                csrf = self.client.get("/api/session").get_json()["csrf_token"]
                self.assertEqual(self.post(f"/api/matches/{match_id}/approval", csrf, {"decision": "accepted"}).status_code, 200)
        self.login("coordinator@foodlink.local")
        coordinator_csrf = self.client.get("/api/session").get_json()["csrf_token"]
        self.assertEqual(self.post(f"/api/matches/{first}/confirm", coordinator_csrf, {}).status_code, 200)
        conflict = self.post(f"/api/matches/{second}/confirm", coordinator_csrf, {})
        self.assertEqual(conflict.status_code, 400)
        self.assertIn("request quantity", conflict.get_json()["error"].lower())
        cancelled = self.post(f"/api/matches/{first}/cancel", coordinator_csrf, {})
        self.assertEqual(cancelled.status_code, 200)
        released = self.post(f"/api/matches/{second}/confirm", coordinator_csrf, {})
        self.assertEqual(released.status_code, 200, released.get_json())

    def test_donation_review_requires_food_checklist_and_rejection_reason(self):
        csrf = self.login("coordinator@foodlink.local")
        incomplete = self.patch("/api/donations/don-2", csrf, {"review_status": "approved", "status": "approved"})
        self.assertEqual(incomplete.status_code, 400)
        rejected = self.patch("/api/donations/don-2", csrf, {
            "review_status": "rejected", "status": "rejected", "rejection_reason": "Packaging seal is damaged.",
        })
        self.assertEqual(rejected.status_code, 200, rejected.get_json())

    def test_match_cannot_be_confirmed_without_both_approvals(self):
        csrf = self.login("coordinator@foodlink.local")
        result = self.post("/api/matches/match-pending/confirm", csrf, {})
        self.assertEqual(result.status_code, 400)
        self.assertIn("both", result.get_json()["error"].lower())


if __name__ == "__main__":
    unittest.main()
