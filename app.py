import csv
import io
import json
import math
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import click
from flask import Flask, current_app, g, jsonify, make_response, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
ROLES = {"administrator", "coordinator", "donor", "partner", "driver"}
COORDINATORS = {"administrator", "coordinator"}
DELIVERY_STATUSES = {
    "scheduled", "pickup_in_progress", "collected", "in_transit", "delivered",
    "pickup_failed", "delayed", "partially_delivered", "rejected_on_arrival",
    "cancelled", "unresolved",
}
DONATION_STATUSES = {
    "new", "under_review", "approved", "matched", "scheduled", "collected",
    "delivered", "rejected", "cancelled", "unresolved",
}
ISSUE_STATUSES = {"open", "under_investigation", "resolved", "closed"}


def new_id():
    return str(uuid.uuid4())


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=15, isolation_level=None)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA busy_timeout = 15000")
    return g.db


def row_dict(row):
    return dict(row) if row is not None else None


def rows(sql, params=()):
    return [dict(row) for row in get_db().execute(sql, params).fetchall()]


def one(sql, params=()):
    return row_dict(get_db().execute(sql, params).fetchone())


def audit(action, entity_type, entity_id=None, details=None):
    user = session.get("user", {})
    get_db().execute(
        "INSERT INTO activity_logs (id, profile_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (new_id(), user.get("id"), action, entity_type, entity_id, json.dumps(details or {}), now_iso()),
    )


def notify_profiles(profile_ids, title, message, entity_type=None, entity_id=None):
    for profile_id in set(profile_ids):
        if profile_id:
            get_db().execute(
                "INSERT INTO notifications (id, profile_id, title, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?)",
                (new_id(), profile_id, title, message, entity_type, entity_id),
            )


def notify_roles(roles, title, message, entity_type=None, entity_id=None, organization_id=None):
    placeholders = ",".join("?" for _ in roles)
    params = list(roles)
    sql = f"SELECT id FROM profiles WHERE active = 1 AND role IN ({placeholders})"
    if organization_id:
        sql += " AND organization_id = ?"
        params.append(organization_id)
    notify_profiles([row["id"] for row in get_db().execute(sql, params)], title, message, entity_type, entity_id)


def api_error(message, status=400):
    return jsonify({"error": message}), status


def require_user(*allowed_roles):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            user = session.get("user")
            if not user:
                return api_error("Please sign in to continue.", 401)
            if allowed_roles and user["role"] not in allowed_roles:
                return api_error("You do not have permission to perform this action.", 403)
            return function(*args, **kwargs)
        return wrapped
    return decorate


def csrf_protected(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        expected = session.get("csrf_token")
        supplied = request.headers.get("X-CSRF-Token")
        if not expected or not supplied or not secrets.compare_digest(expected, supplied):
            return api_error("Your session expired. Refresh and try again.", 403)
        return function(*args, **kwargs)
    return wrapped


def payload():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def required(data, keys):
    missing = [key for key in keys if data.get(key) is None or str(data.get(key)).strip() == ""]
    if missing:
        raise ValueError("Complete all required fields: " + ", ".join(missing))


def positive_number(value, field):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number.")
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{field} must be greater than zero.")
    return result


def validate_datetime(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is required.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{field} must be a valid date and time.")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def scoped_donation(donation_id):
    donation = one(
        """SELECT d.*, o.name AS donor_name, o.service_area AS donor_area,
                  o.contact_name AS donor_contact, o.contact_phone AS donor_phone
           FROM donations d JOIN organizations o ON o.id=d.organization_id WHERE d.id=?""",
        (donation_id,),
    )
    user = session["user"]
    if not donation:
        return None
    if user["role"] == "donor" and donation["organization_id"] != user.get("organization_id"):
        return None
    return donation


def scoped_request(request_id):
    item = one(
        """SELECT r.*, o.name AS partner_name, o.service_area AS partner_area
           FROM food_requests r JOIN organizations o ON o.id=r.organization_id WHERE r.id=?""",
        (request_id,),
    )
    user = session["user"]
    if not item:
        return None
    if user["role"] == "partner" and item["organization_id"] != user.get("organization_id"):
        return None
    return item


def scoped_delivery(delivery_id):
    delivery = one(
        """SELECT d.*, donor.name AS donor_name, donor.contact_name AS donor_contact,
                  donor.contact_phone AS donor_phone, receiver.name AS partner_name,
                  receiver.contact_name AS partner_contact, receiver.contact_phone AS partner_phone,
                  driver.full_name AS driver_name
           FROM deliveries d
           JOIN organizations donor ON donor.id=d.donor_organization_id
           JOIN organizations receiver ON receiver.id=d.receiving_organization_id
           LEFT JOIN profiles driver ON driver.id=d.driver_id
           WHERE d.id=?""",
        (delivery_id,),
    )
    user = session["user"]
    if not delivery:
        return None
    if user["role"] == "donor" and delivery["donor_organization_id"] != user.get("organization_id"):
        return None
    if user["role"] == "partner" and delivery["receiving_organization_id"] != user.get("organization_id"):
        return None
    if user["role"] == "driver" and delivery["driver_id"] != user["id"]:
        return None
    if user["role"] not in COORDINATORS and user["role"] not in {"donor", "partner", "driver"}:
        return None
    return delivery


def record_status(delivery_id, status, quantity_collected=None):
    allowed = {
        "scheduled": {"pickup_in_progress", "pickup_failed", "delayed", "cancelled"},
        "pickup_in_progress": {"collected", "pickup_failed", "delayed", "unresolved"},
        "collected": {"in_transit", "delayed", "unresolved"},
        "in_transit": {"delivered", "partially_delivered", "rejected_on_arrival", "delayed", "unresolved"},
        "delayed": {"pickup_in_progress", "collected", "in_transit", "cancelled", "unresolved"},
        "pickup_failed": {"scheduled", "cancelled", "unresolved"},
        "partially_delivered": {"delivered", "unresolved"},
        "rejected_on_arrival": {"unresolved", "cancelled"},
        "unresolved": {"scheduled", "pickup_in_progress", "collected", "in_transit", "delivered", "cancelled"},
        "delivered": set(),
        "cancelled": set(),
    }
    current = one("SELECT status FROM deliveries WHERE id=?", (delivery_id,))["status"]
    if not isinstance(status, str) or status not in DELIVERY_STATUSES or status not in allowed.get(current, set()):
        raise ValueError(f"Cannot change delivery status from {current.replace('_', ' ')} to {status.replace('_', ' ')}.")
    db = get_db()
    if quantity_collected is None:
        db.execute("UPDATE deliveries SET status=?, updated_at=? WHERE id=?", (status, now_iso(), delivery_id))
    else:
        quantity_collected = float(quantity_collected)
        if not math.isfinite(quantity_collected) or quantity_collected < 0:
            raise ValueError("Collected quantity cannot be negative.")
        db.execute(
            "UPDATE deliveries SET status=?, quantity_collected=?, updated_at=? WHERE id=?",
            (status, quantity_collected, now_iso(), delivery_id),
        )
    audit("delivery_status_changed", "delivery", delivery_id, {"from": current, "to": status})


def seed_demo(db, password_method="scrypt:32768:8:1"):
    if db.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]:
        return
    orgs = [
        ("org-pilot", "FoodLink Pilot Team", "pilot", "Amina El Idrissi", "pilot@example.org", "+212 600 000 001", "Pilot district to be confirmed", "Coordinator operations"),
        ("org-bakery", "Cornerstone Bakery", "donor", "Youssef Benali", "bakery@example.org", "+212 600 000 002", "Central district", "Ambient and chilled food"),
        ("org-market", "Green Basket Market", "donor", "Lina Amrani", "market@example.org", "+212 600 000 003", "Central district", "Produce; chilled storage"),
        ("org-kitchen", "Community Table Kitchen", "community_partner", "Samira Haddad", "kitchen@example.org", "+212 600 000 004", "Central district", "Chilled storage; meal preparation"),
        ("org-shelter", "Neighborhood Food Pantry", "community_partner", "Omar Fassi", "pantry@example.org", "+212 600 000 005", "North district", "Ambient storage"),
        ("org-transport", "Volunteer Transport Team", "transport", "Nadia Karim", "drivers@example.org", "+212 600 000 006", "Pilot district to be confirmed", "Insulated vehicle"),
    ]
    db.executemany(
        """INSERT INTO organizations (id,name,type,contact_name,contact_email,contact_phone,service_area,capabilities)
           VALUES (?,?,?,?,?,?,?,?)""",
        orgs,
    )
    users = [
        ("user-admin", "admin@foodlink.local", "Demo Administrator", "administrator", "org-pilot"),
        ("user-coord", "coordinator@foodlink.local", "Amina El Idrissi", "coordinator", "org-pilot"),
        ("user-donor", "donor@foodlink.local", "Youssef Benali", "donor", "org-bakery"),
        ("user-partner", "partner@foodlink.local", "Samira Haddad", "partner", "org-kitchen"),
        ("user-driver", "driver@foodlink.local", "Nadia Karim", "driver", "org-transport"),
        ("user-market", "market@foodlink.local", "Lina Amrani", "donor", "org-market"),
        ("user-pantry", "pantry@foodlink.local", "Omar Fassi", "partner", "org-shelter"),
    ]
    db.executemany(
        "INSERT INTO profiles (id,email,password_hash,full_name,role,organization_id) VALUES (?,?,?,?,?,?)",
        [(uid, email, generate_password_hash("demo1234", method=password_method), name, role, org) for uid, email, name, role, org in users],
    )
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    iso = lambda delta: (now + delta).isoformat()
    donations = [
        ("don-1", "org-bakery", "Bakery", "Fresh bread and rolls", 42, "items", "Cornerstone Bakery, Central district", iso(timedelta(hours=2)), iso(timedelta(hours=5)), iso(timedelta(days=1)), "Ambient; keep dry", "", "Wheat", "approved", "approved", "user-donor"),
        ("don-2", "org-market", "Produce", "Seasonal mixed vegetables", 36, "kg", "Green Basket Market, Central district", iso(timedelta(hours=5)), iso(timedelta(hours=8)), iso(timedelta(days=2)), "Cool storage preferred", "Insulated vehicle recommended", "", "pending", "under_review", "user-market"),
        ("don-3", "org-bakery", "Prepared meals", "Packaged lunch portions", 24, "items", "Cornerstone Bakery, Central district", iso(timedelta(hours=1)), iso(timedelta(hours=3)), iso(timedelta(hours=8)), "Keep chilled", "Maintain cold chain", "Milk, eggs", "approved", "approved", "user-donor"),
        ("don-4", "org-market", "Dairy", "Sealed yogurt cups", 18, "items", "Green Basket Market, Central district", iso(timedelta(days=-1)), iso(timedelta(hours=1)), iso(timedelta(days=1)), "Keep refrigerated", "Maintain cold chain", "Milk", "pending", "new", "user-market"),
    ]
    db.executemany(
        """INSERT INTO donations (id,organization_id,category,description,quantity,unit,pickup_location,pickup_from,pickup_until,use_by,storage_requirements,transport_requirements,allergens,review_status,status,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        donations,
    )
    requests = [
        ("req-1", "org-kitchen", json.dumps(["Bakery", "Produce"]), "Ingredients for community meal service", 30, "items", "Community Table Kitchen, Central district", iso(timedelta(days=1)), "Chilled storage available", "high", "open", "user-partner"),
        ("req-2", "org-shelter", json.dumps(["Prepared meals"]), "Ready-to-serve meals for pantry distribution", 20, "items", "Neighborhood Food Pantry, North district", iso(timedelta(days=1)), "Ambient on arrival", "urgent", "open", "user-pantry"),
        ("req-3", "org-kitchen", json.dumps(["Dairy"]), "Dairy products for meal preparation", 12, "items", "Community Table Kitchen, Central district", iso(timedelta(days=2)), "Refrigerated storage", "standard", "open", "user-partner"),
    ]
    db.executemany(
        """INSERT INTO food_requests (id,organization_id,categories,description,quantity,unit,destination,required_by,handling_requirements,priority,status,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        requests,
    )
    db.execute(
        """INSERT INTO matches (id,donation_id,request_id,proposed_quantity,unit,proposed_pickup,proposed_delivery,transport_feasible,timing_feasible,status,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        ("match-pending", "don-1", "req-1", 20, "items", iso(timedelta(hours=2)), iso(timedelta(hours=4)), 1, 1, "proposed", "user-coord"),
    )
    db.execute(
        """INSERT INTO matches (id,donation_id,request_id,proposed_quantity,unit,proposed_pickup,proposed_delivery,transport_feasible,timing_feasible,status,created_by,confirmed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        ("match-done", "don-3", "req-2", 12, "items", iso(timedelta(hours=1)), iso(timedelta(hours=2)), 1, 1, "confirmed", "user-coord", iso(timedelta(days=-1))),
    )
    db.executemany(
        "INSERT INTO match_approvals (id,match_id,role,profile_id,decision) VALUES (?,?,?,?,?)",
        [("approval-donor", "match-done", "donor", "user-donor", "accepted"),
         ("approval-partner", "match-done", "partner", "user-pantry", "accepted")],
    )
    db.execute(
        """INSERT INTO deliveries (id,match_id,donor_organization_id,receiving_organization_id,pickup_location,destination,scheduled_pickup,scheduled_delivery,coordinator_id,driver_id,quantity_expected,unit,quantity_collected,quantity_received,status,handling_instructions,confirmation_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        ("delivery-demo", "match-done", "org-bakery", "org-shelter", "Cornerstone Bakery, Central district", "Neighborhood Food Pantry, North district", iso(timedelta(days=-1)), iso(timedelta(days=-1, hours=1)), "user-coord", "user-driver", 12, "items", 12, 10, "partially_delivered", "Keep chilled; call receiving contact on arrival", iso(timedelta(days=-1, hours=1))),
    )
    db.execute(
        "INSERT INTO delivery_assignments (id,delivery_id,profile_id,assigned_by,role) VALUES (?,?,?,?,?)",
        ("assignment-demo", "delivery-demo", "user-driver", "user-coord", "driver"),
    )
    db.execute(
        """INSERT INTO delivery_confirmations (id,delivery_id,confirmed_by,quantity_expected,quantity_received,unit,condition_on_arrival,acceptance)
           VALUES (?,?,?,?,?,?,?,?)""",
        ("confirmation-demo", "delivery-demo", "user-pantry", 12, 10, "items", "Two packages missing; remaining items sealed and cool.", "partially_accepted"),
    )
    db.execute(
        """INSERT INTO delivery_issues (id,delivery_id,category,description,follow_up_action,status,created_by,assigned_to)
           VALUES (?,?,?,?,?,?,?,?)""",
        ("issue-demo", "delivery-demo", "quantity_discrepancy", "Received 10 of 12 expected items.", "Coordinator to reconcile pickup count with driver.", "open", "user-pantry", "user-coord"),
    )
    db.execute("UPDATE food_requests SET status='partially_fulfilled' WHERE id='req-2'")
    db.execute(
        """INSERT INTO activity_logs (id,profile_id,action,entity_type,entity_id,details,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        ("activity-demo", "user-pantry", "delivery_discrepancy_reported", "delivery", "delivery-demo", json.dumps({"expected": 12, "received": 10}), iso(timedelta(hours=-2))),
    )
    db.execute(
        """UPDATE pilot_settings SET accepted_categories=?, safety_checklist=?, scheduling_rules=?, transport_capacity=?
           WHERE id=1""",
        (json.dumps(["Bakery", "Produce", "Prepared meals", "Dairy"]),
         json.dumps(["Local requirements verified by pilot team", "Food condition reviewed", "Packaging intact", "Labels and allergen information recorded", "Freshness/use-by timing appropriate", "Storage and transport needs compatible"]),
         "Schedule within the donor pickup window and before the partner's required-by time.",
         "Confirm vehicle capacity and cold-chain capability with assigned transport provider."),
    )
    for uid, title, message, entity, entity_id in [
        ("user-coord", "Match awaiting approval", "Cornerstone Bakery's proposal needs donor and partner approval.", "match", "match-pending"),
        ("user-coord", "Quantity discrepancy", "A delivery was received short; coordinator follow-up is required.", "delivery", "delivery-demo"),
        ("user-driver", "Upcoming delivery", "Review the assigned pickup and handling instructions.", "delivery", "delivery-demo"),
    ]:
        db.execute(
            "INSERT INTO notifications (id,profile_id,title,message,entity_type,entity_id) VALUES (?,?,?,?,?,?)",
            (new_id(), uid, title, message, entity, entity_id),
        )


def create_app(test_config=None):
    app = Flask(__name__, static_folder="static")
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("FLASK_SECRET_KEY", "local-demo-only-change-before-deployment"),
        DATABASE=os.environ.get("FOODLINK_DATABASE", str(BASE_DIR / "foodlink.sqlite3")),
        DEMO_MODE=os.environ.get("FOODLINK_DEMO_MODE", "true").lower() == "true",
        SEED_DEMO=os.environ.get("FOODLINK_SEED_DEMO", "true").lower() == "true",
        PASSWORD_HASH_METHOD="scrypt:32768:8:1",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV") == "production",
        MAX_CONTENT_LENGTH=1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)
    if app.config["SECRET_KEY"] == "local-demo-only-change-before-deployment" and not app.config["TESTING"]:
        app.logger.warning("Using the development-only session key. Set FLASK_SECRET_KEY before deployment.")

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response

    @app.teardown_appcontext
    def close_db(_error):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    def initialize_database():
        connection = sqlite3.connect(app.config["DATABASE"])
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript((BASE_DIR / "migrations" / "001_initial.sql").read_text(encoding="utf-8"))
        if app.config["SEED_DEMO"]:
            seed_demo(connection, app.config["PASSWORD_HASH_METHOD"])
        elif not connection.execute("SELECT 1 FROM organizations WHERE type='pilot' LIMIT 1").fetchone():
            connection.execute(
                """INSERT INTO organizations (id,name,type,service_area,capabilities)
                   VALUES ('org-pilot','FoodLink Pilot Team','pilot','Pilot location to be confirmed','Coordinator operations')"""
            )
        connection.commit()
        connection.close()

    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    initialize_database()

    @app.cli.command("create-admin")
    def create_admin():
        with app.app_context():
            if one("SELECT id FROM profiles WHERE role='administrator' AND active=1"):
                raise click.ClickException("An active administrator already exists.")
            email = click.prompt("Administrator work email").strip().lower()
            full_name = click.prompt("Administrator full name").strip()
            password = click.prompt("Initial password", hide_input=True, confirmation_prompt=True)
            if len(password) < 12:
                raise click.ClickException("Initial password must be at least 12 characters.")
            pilot_org = one("SELECT id FROM organizations WHERE type='pilot' ORDER BY created_at LIMIT 1")
            if not pilot_org:
                raise click.ClickException("Create a pilot team organization before adding an administrator.")
            get_db().execute(
                "INSERT INTO profiles (id,email,password_hash,full_name,role,organization_id) VALUES (?,?,?,?,?,?)",
                (new_id(), email, generate_password_hash(password, method=app.config["PASSWORD_HASH_METHOD"]),
                 full_name, "administrator", pilot_org["id"]),
            )
            click.echo(f"Administrator account created for {email}.")

    @app.get("/")
    def index():
        return send_from_directory(BASE_DIR / "static", "index.html")

    @app.get("/<path:asset>")
    def static_asset(asset):
        return send_from_directory(BASE_DIR / "static", asset)

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return api_error("The requested record was not found.", 404)
        return send_from_directory(BASE_DIR / "static", "index.html")

    @app.errorhandler(413)
    def too_large(_error):
        return api_error("Request payload is too large.", 413)

    @app.get("/api/session")
    def get_session():
        user = session.get("user")
        if user:
            current = one(
                "SELECT id,email,full_name,role,organization_id FROM profiles WHERE id=? AND active=1",
                (user["id"],),
            )
            if not current:
                session.clear()
                return jsonify({"user": None, "demo_mode": app.config["DEMO_MODE"]})
            session["user"] = {
                "id": current["id"], "email": current["email"], "name": current["full_name"],
                "role": current["role"], "organization_id": current["organization_id"],
            }
        if session.get("user") and not session.get("csrf_token"):
            session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify({"user": session.get("user"), "csrf_token": session.get("csrf_token"),
                        "demo_mode": app.config["DEMO_MODE"]})

    @app.post("/api/login")
    def login():
        data = payload()
        email = str(data.get("email", "")).strip().lower()
        password = data.get("password", "")
        if not email or not isinstance(password, str):
            return api_error("Enter your email and password.")
        profile = one("SELECT * FROM profiles WHERE email=? AND active=1", (email,))
        if not profile or not check_password_hash(profile["password_hash"], password):
            return api_error("Email or password was not recognized.", 401)
        session.clear()
        session["user"] = {"id": profile["id"], "email": profile["email"], "name": profile["full_name"],
                           "role": profile["role"], "organization_id": profile["organization_id"]}
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify({"user": session["user"], "csrf_token": session["csrf_token"], "demo_mode": app.config["DEMO_MODE"]})

    @app.post("/api/logout")
    @require_user()
    @csrf_protected
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.post("/api/password-reset")
    def password_reset():
        data = payload()
        if not data.get("email"):
            return api_error("Enter the email address for the account.")
        return jsonify({"message": "If the account exists, reset instructions will be sent when an email provider is configured.",
                        "external_delivery_configured": False})

    @app.get("/api/bootstrap")
    @require_user()
    def bootstrap():
        user = session["user"]
        role = user["role"]
        is_coord = role in COORDINATORS
        if is_coord:
            donations = rows("""SELECT d.*,o.name AS donor_name,o.service_area AS donor_area
                                FROM donations d JOIN organizations o ON o.id=d.organization_id ORDER BY d.created_at DESC""")
            requests_data = rows("""SELECT r.*,o.name AS partner_name,o.service_area AS partner_area
                                    FROM food_requests r JOIN organizations o ON o.id=r.organization_id ORDER BY r.created_at DESC""")
            matches = rows("""SELECT m.*,d.description AS donation_description,d.category,d.organization_id AS donor_org_id,
                                     don.name AS donor_name,r.description AS request_description,r.organization_id AS partner_org_id,
                                     rec.name AS partner_name,r.destination,r.required_by
                              FROM matches m JOIN donations d ON d.id=m.donation_id
                              JOIN organizations don ON don.id=d.organization_id
                              JOIN food_requests r ON r.id=m.request_id
                              JOIN organizations rec ON rec.id=r.organization_id ORDER BY m.created_at DESC""")
            organizations = rows("SELECT * FROM organizations ORDER BY name")
            activities = rows("""SELECT a.*,p.full_name FROM activity_logs a LEFT JOIN profiles p ON p.id=a.profile_id
                                 ORDER BY a.created_at DESC LIMIT 20""")
            team = rows("SELECT id,email,full_name,role,organization_id,active FROM profiles ORDER BY full_name")
        elif role == "donor":
            donations = rows("""SELECT d.*,o.name AS donor_name,o.service_area AS donor_area FROM donations d
                                JOIN organizations o ON o.id=d.organization_id WHERE d.organization_id=? ORDER BY d.created_at DESC""",
                             (user["organization_id"],))
            requests_data, organizations, activities, team = [], [], [], []
            matches = rows("""SELECT m.*,d.description AS donation_description,d.category,d.organization_id AS donor_org_id,
                                     don.name AS donor_name,r.description AS request_description,r.organization_id AS partner_org_id,
                                     rec.name AS partner_name,r.destination,r.required_by
                              FROM matches m JOIN donations d ON d.id=m.donation_id JOIN organizations don ON don.id=d.organization_id
                              JOIN food_requests r ON r.id=m.request_id JOIN organizations rec ON rec.id=r.organization_id
                              WHERE d.organization_id=? ORDER BY m.created_at DESC""", (user["organization_id"],))
        elif role == "partner":
            requests_data = rows("""SELECT r.*,o.name AS partner_name,o.service_area AS partner_area FROM food_requests r
                                    JOIN organizations o ON o.id=r.organization_id WHERE r.organization_id=? ORDER BY r.created_at DESC""",
                                 (user["organization_id"],))
            donations, organizations, activities, team = [], [], [], []
            matches = rows("""SELECT m.*,d.description AS donation_description,d.category,d.organization_id AS donor_org_id,
                                     don.name AS donor_name,r.description AS request_description,r.organization_id AS partner_org_id,
                                     rec.name AS partner_name,r.destination,r.required_by
                              FROM matches m JOIN donations d ON d.id=m.donation_id JOIN organizations don ON don.id=d.organization_id
                              JOIN food_requests r ON r.id=m.request_id JOIN organizations rec ON rec.id=r.organization_id
                              WHERE r.organization_id=? ORDER BY m.created_at DESC""", (user["organization_id"],))
        else:
            donations, requests_data, organizations, activities, team, matches = [], [], [], [], [], []
        for match in matches:
            match["approvals"] = rows(
                "SELECT role,decision,note,created_at FROM match_approvals WHERE match_id=?",
                (match["id"],),
            )
        if role in {"administrator", "coordinator"}:
            deliveries = rows("""SELECT d.*,don.name AS donor_name,don.contact_name AS donor_contact,don.contact_phone AS donor_phone,
                                        rec.name AS partner_name,rec.contact_name AS partner_contact,rec.contact_phone AS partner_phone,
                                        p.full_name AS driver_name
                                 FROM deliveries d JOIN organizations don ON don.id=d.donor_organization_id
                                 JOIN organizations rec ON rec.id=d.receiving_organization_id
                                 LEFT JOIN profiles p ON p.id=d.driver_id ORDER BY d.scheduled_pickup DESC""")
            issues = rows("""SELECT i.*,d.id AS delivery_code,d.status AS delivery_status,p.full_name AS assignee_name
                             FROM delivery_issues i JOIN deliveries d ON d.id=i.delivery_id
                             LEFT JOIN profiles p ON p.id=i.assigned_to ORDER BY i.created_at DESC""")
        elif role == "donor":
            deliveries = rows("""SELECT d.* FROM deliveries d WHERE d.donor_organization_id=? ORDER BY d.scheduled_pickup DESC""",
                              (user["organization_id"],))
            issues = []
        elif role == "partner":
            deliveries = rows("""SELECT d.* FROM deliveries d WHERE d.receiving_organization_id=? ORDER BY d.scheduled_pickup DESC""",
                              (user["organization_id"],))
            issues = rows("""SELECT i.*,d.id AS delivery_code,d.status AS delivery_status FROM delivery_issues i
                             JOIN deliveries d ON d.id=i.delivery_id WHERE d.receiving_organization_id=? ORDER BY i.created_at DESC""",
                          (user["organization_id"],))
        else:
            deliveries = rows("""SELECT d.*,don.name AS donor_name,don.contact_name AS donor_contact,don.contact_phone AS donor_phone,
                                        rec.name AS partner_name,rec.contact_name AS partner_contact,rec.contact_phone AS partner_phone
                                 FROM deliveries d JOIN organizations don ON don.id=d.donor_organization_id
                                 JOIN organizations rec ON rec.id=d.receiving_organization_id
                                 WHERE d.driver_id=? ORDER BY d.scheduled_pickup DESC""", (user["id"],))
            issues = []
        if role in {"administrator", "coordinator"}:
            settings = one("SELECT * FROM pilot_settings WHERE id=1")
        else:
            settings = one("SELECT pilot_name,district,start_date,end_date,accepted_categories,accepted_units,updated_at FROM pilot_settings WHERE id=1")
        notifications = rows("SELECT * FROM notifications WHERE profile_id=? ORDER BY created_at DESC LIMIT 30", (user["id"],))
        feedback = rows("""SELECT f.*,o.name AS organization_name FROM partner_feedback f
                           JOIN organizations o ON o.id=f.organization_id ORDER BY f.created_at DESC LIMIT 100""") if is_coord else []
        return jsonify({
            "user": user, "donations": donations, "requests": requests_data, "matches": matches,
            "deliveries": deliveries, "issues": issues, "organizations": organizations, "team": team,
            "activities": activities, "notifications": notifications, "settings": settings,
            "feedback": feedback, "demo_mode": app.config["DEMO_MODE"],
        })

    @app.post("/api/donations")
    @require_user("donor", "administrator", "coordinator")
    @csrf_protected
    def create_donation():
        data = payload()
        try:
            required(data, ["category", "description", "quantity", "unit", "pickup_location", "pickup_from", "pickup_until", "submission_key"])
            if len(str(data["submission_key"])) > 128:
                raise ValueError("Submission identifier is too long.")
            existing = one("SELECT id FROM donations WHERE created_by=? AND submission_key=?",
                           (session["user"]["id"], data["submission_key"]))
            if existing:
                return jsonify({"id": existing["id"], "duplicate": True})
            quantity = positive_number(data["quantity"], "Quantity")
            configured_categories = json.loads(one("SELECT accepted_categories FROM pilot_settings WHERE id=1")["accepted_categories"])
            if configured_categories and data["category"] not in configured_categories:
                raise ValueError("This food category is not enabled for the pilot.")
            pickup_from = validate_datetime(data["pickup_from"], "Pickup start")
            pickup_until = validate_datetime(data["pickup_until"], "Pickup end")
            use_by = validate_datetime(data["use_by"], "Freshness / use-by time") if data.get("use_by") else None
            if pickup_until < pickup_from:
                raise ValueError("Pickup end must be after pickup start.")
            org_id = session["user"].get("organization_id") if session["user"]["role"] == "donor" else data.get("organization_id")
            org = one("SELECT id,type FROM organizations WHERE id=?", (org_id,))
            if not org or org["type"] != "donor":
                raise ValueError("Choose a registered donor organization.")
            donation_id = new_id()
            db = get_db()
            db.execute(
                """INSERT INTO donations (id,organization_id,category,description,quantity,unit,pickup_location,pickup_from,pickup_until,use_by,
                           storage_requirements,transport_requirements,allergens,created_by,submitted_at,submission_key)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (donation_id, org_id, data["category"].strip(), data["description"].strip(), quantity, data["unit"].strip(),
                 data["pickup_location"].strip(), pickup_from, pickup_until,                  use_by,
                 data.get("storage_requirements", "").strip(), data.get("transport_requirements", "").strip(),
                     data.get("allergens", "").strip(), session["user"]["id"], now_iso(), data["submission_key"]),
            )
            audit("donation_submitted", "donation", donation_id, {"quantity": quantity, "unit": data["unit"]})
            notify_roles(COORDINATORS, "New donation submitted", f"{data['category']} offer needs review.", "donation", donation_id)
            return jsonify({"id": donation_id}), 201
        except ValueError as error:
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            existing = one("SELECT id FROM donations WHERE created_by=? AND submission_key=?",
                           (session["user"]["id"], data.get("submission_key")))
            if existing:
                return jsonify({"id": existing["id"], "duplicate": True})
            return api_error(f"Donation could not be saved: {error}")

    @app.patch("/api/donations/<donation_id>")
    @require_user("administrator", "coordinator", "donor")
    @csrf_protected
    def update_donation(donation_id):
        item = one("SELECT * FROM donations WHERE id=?", (donation_id,))
        if not item:
            return api_error("Donation not found.", 404)
        data = payload()
        if session["user"]["role"] == "donor":
            if item["organization_id"] != session["user"]["organization_id"]:
                return api_error("You can only manage your organization's offers.", 403)
            if data.get("status") != "cancelled":
                return api_error("Donors can cancel their own offer; coordinator review outcomes cannot be changed.")
            reserved = one("SELECT COALESCE(SUM(proposed_quantity),0) AS quantity FROM matches WHERE donation_id=? AND status='confirmed'",
                           (donation_id,))["quantity"]
            if reserved:
                return api_error("This offer has confirmed allocations. Ask a coordinator to cancel the match first.")
            get_db().execute("UPDATE donations SET status='cancelled',updated_at=? WHERE id=?", (now_iso(), donation_id))
            audit("donation_cancelled", "donation", donation_id)
            return jsonify({"ok": True})
        status = data.get("status", item["status"])
        review_status = data.get("review_status", item["review_status"])
        if status not in DONATION_STATUSES or review_status not in {"pending", "approved", "rejected"}:
            return api_error("Choose a valid donation and food review status.")
        rejection = data.get("rejection_reason", item["rejection_reason"])
        if (review_status == "rejected" or status == "rejected") and not str(rejection or "").strip():
            return api_error("Record a reason when rejecting food.")
        if status == "approved" and review_status != "approved":
            return api_error("Approve the food review before setting the donation status to approved.")
        if status == "rejected":
            review_status = "rejected"
        checklist = data.get("safety_checklist", json.loads(item["safety_checklist"] or "{}"))
        if review_status == "approved":
            required_checks = json.loads(one("SELECT safety_checklist FROM pilot_settings WHERE id=1")["safety_checklist"])
            missing = [check for check in required_checks if not checklist.get(check)]
            if missing:
                return api_error("Complete the configured food review checklist before approval.")
        get_db().execute(
            """UPDATE donations SET status=?,review_status=?,safety_checklist=?,rejection_reason=?,coordinator_notes=?,updated_at=? WHERE id=?""",
            (status, review_status, json.dumps(checklist), rejection, data.get("coordinator_notes", item["coordinator_notes"]), now_iso(), donation_id),
        )
        audit("donation_reviewed", "donation", donation_id, {"status": status, "review_status": review_status})
        return jsonify({"ok": True})

    @app.post("/api/requests")
    @require_user("partner", "administrator", "coordinator")
    @csrf_protected
    def create_request():
        data = payload()
        try:
            required(data, ["categories", "description", "quantity", "unit", "destination", "required_by", "submission_key"])
            if len(str(data["submission_key"])) > 128:
                raise ValueError("Submission identifier is too long.")
            existing = one("SELECT id FROM food_requests WHERE created_by=? AND submission_key=?",
                           (session["user"]["id"], data["submission_key"]))
            if existing:
                return jsonify({"id": existing["id"], "duplicate": True})
            quantity = positive_number(data["quantity"], "Quantity")
            validate_datetime(data["required_by"], "Required-by date")
            categories = data["categories"]
            if isinstance(categories, str):
                categories = [item.strip() for item in categories.split(",") if item.strip()]
            if not categories:
                raise ValueError("Select at least one food category.")
            priority = data.get("priority", "standard")
            if priority not in {"standard", "high", "urgent"}:
                raise ValueError("Choose a valid priority.")
            org_id = session["user"].get("organization_id") if session["user"]["role"] == "partner" else data.get("organization_id")
            org = one("SELECT id,type FROM organizations WHERE id=?", (org_id,))
            if not org or org["type"] != "community_partner":
                raise ValueError("Choose a registered community partner.")
            request_id = new_id()
            get_db().execute(
                """INSERT INTO food_requests (id,organization_id,categories,description,quantity,unit,destination,required_by,handling_requirements,priority,created_by,submission_key)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (request_id, org_id, json.dumps(categories), data["description"].strip(), quantity, data["unit"].strip(),
                 data["destination"].strip(), data["required_by"], data.get("handling_requirements", "").strip(), priority,
                 session["user"]["id"], data["submission_key"]),
            )
            audit("request_submitted", "request", request_id, {"quantity": quantity, "unit": data["unit"]})
            notify_roles(COORDINATORS, "Food request needs review", f"{org['id']} submitted a food request.", "request", request_id)
            return jsonify({"id": request_id}), 201
        except ValueError as error:
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            existing = one("SELECT id FROM food_requests WHERE created_by=? AND submission_key=?",
                           (session["user"]["id"], data.get("submission_key")))
            if existing:
                return jsonify({"id": existing["id"], "duplicate": True})
            return api_error(f"Request could not be saved: {error}")

    @app.patch("/api/requests/<request_id>")
    @require_user("partner", "administrator", "coordinator")
    @csrf_protected
    def update_request(request_id):
        item = one("SELECT * FROM food_requests WHERE id=?", (request_id,))
        if not item:
            return api_error("Request not found.", 404)
        if session["user"]["role"] == "partner" and item["organization_id"] != session["user"]["organization_id"]:
            return api_error("You can only update your organization's requests.", 403)
        data = payload()
        status = data.get("status", item["status"])
        if status not in {"open", "cancelled"} and session["user"]["role"] not in COORDINATORS:
            return api_error("Partners can only cancel or reopen their requests.", 403)
        if status not in {"open", "partially_fulfilled", "fulfilled", "expired", "cancelled"}:
            return api_error("Choose a valid request status.")
        get_db().execute("UPDATE food_requests SET status=?,coordinator_notes=?,updated_at=? WHERE id=?",
                         (status, data.get("coordinator_notes", item["coordinator_notes"]), now_iso(), request_id))
        audit("request_updated", "request", request_id, {"status": status})
        return jsonify({"ok": True})

    @app.get("/api/matches")
    @require_user()
    def match_suggestions():
        if session["user"]["role"] not in COORDINATORS:
            return api_error("Match suggestions are available to coordinators.", 403)
        donations = rows("""SELECT d.*,o.name AS donor_name,
                                   d.quantity-COALESCE((SELECT SUM(m.proposed_quantity) FROM matches m
                                                       WHERE m.donation_id=d.id AND m.status='confirmed'),0) AS available_quantity
                            FROM donations d JOIN organizations o ON o.id=d.organization_id
                            WHERE d.review_status='approved' AND d.status IN ('approved','matched') ORDER BY d.use_by""")
        requests_data = rows("""SELECT r.*,o.name AS partner_name,
                                       r.quantity-COALESCE((SELECT SUM(m.proposed_quantity) FROM matches m
                                                           WHERE m.request_id=r.id AND m.status='confirmed'),0) AS remaining_quantity
                                FROM food_requests r JOIN organizations o ON o.id=r.organization_id
                                WHERE r.status IN ('open','partially_fulfilled') ORDER BY r.required_by""")
        return jsonify({"donations": donations, "requests": requests_data})

    @app.post("/api/matches")
    @require_user("administrator", "coordinator")
    @csrf_protected
    def create_match():
        data = payload()
        try:
            required(data, ["donation_id", "request_id", "quantity", "pickup", "delivery"])
            quantity = positive_number(data["quantity"], "Proposed quantity")
            pickup = validate_datetime(data["pickup"], "Pickup time")
            delivery_time = validate_datetime(data["delivery"], "Delivery time")
            if delivery_time < pickup:
                raise ValueError("Delivery must be scheduled after pickup.")
            donation = one("SELECT * FROM donations WHERE id=?", (data["donation_id"],))
            request_row = one("SELECT * FROM food_requests WHERE id=?", (data["request_id"],))
            if not donation or not request_row:
                raise ValueError("Choose an existing donation and request.")
            if request_row["status"] not in {"open", "partially_fulfilled"}:
                raise ValueError("Only open or partially fulfilled requests can be matched.")
            if donation["review_status"] != "approved" or donation["status"] not in {"approved", "matched"}:
                raise ValueError("Only food approved by a coordinator can be proposed.")
            pickup_from = datetime.fromisoformat(donation["pickup_from"].replace("Z", "+00:00"))
            pickup_until = datetime.fromisoformat(donation["pickup_until"].replace("Z", "+00:00"))
            pickup_dt = datetime.fromisoformat(pickup.replace("Z", "+00:00"))
            if pickup_dt < pickup_from or pickup_dt > pickup_until:
                raise ValueError("Proposed pickup must be within the donor's available pickup window.")
            requested_categories = json.loads(request_row["categories"])
            if donation["category"] not in requested_categories:
                raise ValueError("This donation's category is not among the partner's requested categories.")
            if donation["unit"].lower() != request_row["unit"].lower():
                raise ValueError("Donation and request units must match.")
            reserved_donation = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE donation_id=? AND status='confirmed'", (donation["id"],))["total"]
            reserved_request = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE request_id=? AND status='confirmed'", (request_row["id"],))["total"]
            if quantity > donation["quantity"] - reserved_donation:
                raise ValueError("Proposed quantity exceeds the donation quantity still available.")
            if quantity > request_row["quantity"] - reserved_request:
                raise ValueError("Proposed quantity exceeds the request quantity still needed.")
            if delivery_time > request_row["required_by"]:
                raise ValueError("Proposed delivery is later than the partner's required-by date.")
            if donation["use_by"] and delivery_time > donation["use_by"]:
                raise ValueError("Proposed delivery is after the food use-by time.")
            if data.get("transport_feasible") is not True or data.get("timing_feasible") is not True:
                raise ValueError("Coordinator must confirm both transport and timing feasibility.")
            match_id = new_id()
            get_db().execute(
                """INSERT INTO matches (id,donation_id,request_id,proposed_quantity,unit,proposed_pickup,proposed_delivery,
                    transport_feasible,timing_feasible,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (match_id, donation["id"], request_row["id"], quantity, donation["unit"], pickup, delivery_time, 1, 1, session["user"]["id"]),
            )
            audit("match_proposed", "match", match_id, {"quantity": quantity, "unit": donation["unit"]})
            notify_roles({"donor"}, "Match proposal awaits your decision", "A coordinator proposed a donation for a community request.",
                         "match", match_id, donation["organization_id"])
            notify_roles({"partner"}, "Match proposal awaits your decision", "A coordinator proposed a donation for your request.",
                         "match", match_id, request_row["organization_id"])
            return jsonify({"id": match_id}), 201
        except ValueError as error:
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            return api_error(f"Match could not be proposed: {error}")

    @app.post("/api/matches/<match_id>/approval")
    @require_user("donor", "partner")
    @csrf_protected
    def approve_match(match_id):
        data = payload()
        decision = data.get("decision")
        if decision not in {"accepted", "declined"}:
            return api_error("Choose accept or decline.")
        match = one(
            """SELECT m.*,d.organization_id AS donor_org,r.organization_id AS partner_org
               FROM matches m JOIN donations d ON d.id=m.donation_id JOIN food_requests r ON r.id=m.request_id WHERE m.id=?""",
            (match_id,),
        )
        if not match or match["status"] != "proposed":
            return api_error("This match proposal is no longer awaiting approval.", 404)
        user = session["user"]
        role = user["role"]
        expected_org = match["donor_org"] if role == "donor" else match["partner_org"]
        if user.get("organization_id") != expected_org:
            return api_error("This proposal is not assigned to your organization.", 403)
        db = get_db()
        db.execute(
            """INSERT INTO match_approvals (id,match_id,role,profile_id,decision,note) VALUES (?,?,?,?,?,?)
               ON CONFLICT(match_id,role) DO UPDATE SET profile_id=excluded.profile_id,decision=excluded.decision,note=excluded.note,created_at=CURRENT_TIMESTAMP""",
            (new_id(), match_id, role, user["id"], decision, str(data.get("note", "")).strip()),
        )
        if decision == "declined":
            db.execute("UPDATE matches SET status='declined',updated_at=? WHERE id=?", (now_iso(), match_id))
        audit("match_approval_recorded", "match", match_id, {"role": role, "decision": decision})
        if decision == "accepted":
            notify_roles(COORDINATORS, "Match approval recorded", f"The {role} accepted a proposed match.", "match", match_id)
        return jsonify({"ok": True})

    @app.post("/api/matches/<match_id>/confirm")
    @require_user("administrator", "coordinator")
    @csrf_protected
    def confirm_match(match_id):
        data = payload()
        required_driver = data.get("driver_id")
        try:
            db = get_db()
            db.execute("BEGIN IMMEDIATE")
            match = one("SELECT * FROM matches WHERE id=?", (match_id,))
            if not match or match["status"] != "proposed":
                raise ValueError("This match is not awaiting confirmation.")
            approvals = rows("SELECT role,decision FROM match_approvals WHERE match_id=?", (match_id,))
            approval_map = {approval["role"]: approval["decision"] for approval in approvals}
            if approval_map.get("donor") != "accepted" or approval_map.get("partner") != "accepted":
                raise ValueError("Both the donor and community partner must accept before confirmation.")
            if not match["transport_feasible"] or not match["timing_feasible"]:
                raise ValueError("Transport and timing feasibility must be confirmed.")
            donation = one("SELECT * FROM donations WHERE id=?", (match["donation_id"],))
            request_row = one("SELECT * FROM food_requests WHERE id=?", (match["request_id"],))
            reserved_donation = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE donation_id=? AND status='confirmed'", (donation["id"],))["total"]
            reserved_request = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE request_id=? AND status='confirmed'", (request_row["id"],))["total"]
            if match["proposed_quantity"] > donation["quantity"] - reserved_donation:
                raise ValueError("Donation quantity has already been reserved by another confirmed match.")
            if match["proposed_quantity"] > request_row["quantity"] - reserved_request:
                raise ValueError("Request quantity has already been fulfilled by another confirmed match.")
            driver = None
            if required_driver:
                driver = one("SELECT id,role FROM profiles WHERE id=? AND active=1", (required_driver,))
                if not driver or driver["role"] != "driver":
                    raise ValueError("Choose an active driver or volunteer.")
            match_now = now_iso()
            db.execute("UPDATE matches SET status='confirmed',confirmed_at=?,updated_at=? WHERE id=?", (match_now, match_now, match_id))
            donation_reserved_after = reserved_donation + match["proposed_quantity"]
            donation_status = "matched" if donation_reserved_after < donation["quantity"] else "scheduled"
            request_reserved_after = reserved_request + match["proposed_quantity"]
            request_status = "partially_fulfilled" if request_reserved_after < request_row["quantity"] else "fulfilled"
            db.execute("UPDATE donations SET status=?,updated_at=? WHERE id=?", (donation_status, match_now, donation["id"]))
            db.execute("UPDATE food_requests SET status=?,updated_at=? WHERE id=?", (request_status, match_now, request_row["id"]))
            delivery_id = new_id()
            db.execute(
                """INSERT INTO deliveries (id,match_id,donor_organization_id,receiving_organization_id,pickup_location,destination,
                    scheduled_pickup,scheduled_delivery,coordinator_id,driver_id,quantity_expected,unit,handling_instructions)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (delivery_id, match_id, donation["organization_id"], request_row["organization_id"], donation["pickup_location"],
                 request_row["destination"], match["proposed_pickup"], match["proposed_delivery"], session["user"]["id"],
                 required_driver, match["proposed_quantity"], donation["unit"],
                 donation["storage_requirements"] + " " + donation["transport_requirements"]),
            )
            db.execute("INSERT INTO delivery_assignments (id,delivery_id,profile_id,assigned_by,role) VALUES (?,?,?,?,?)",
                       (new_id(), delivery_id, session["user"]["id"], session["user"]["id"], "coordinator"))
            if required_driver:
                db.execute("INSERT INTO delivery_assignments (id,delivery_id,profile_id,assigned_by,role) VALUES (?,?,?,?,?)",
                           (new_id(), delivery_id, required_driver, session["user"]["id"], "driver"))
            audit("match_confirmed", "match", match_id, {"delivery_id": delivery_id, "driver_id": required_driver})
            notify_roles({"donor"}, "Match confirmed", "The coordinator confirmed the approved donation match.", "match", match_id, donation["organization_id"])
            notify_roles({"partner"}, "Match confirmed", "Your approved donation match is scheduled.", "match", match_id, request_row["organization_id"])
            if required_driver:
                notify_profiles([required_driver], "Delivery assigned", "A new delivery has been assigned to you.", "delivery", delivery_id)
            db.execute("COMMIT")
            return jsonify({"ok": True, "delivery_id": delivery_id})
        except ValueError as error:
            if get_db().in_transaction:
                get_db().execute("ROLLBACK")
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            if get_db().in_transaction:
                get_db().execute("ROLLBACK")
            return api_error(f"Match could not be confirmed: {error}")

    @app.post("/api/matches/<match_id>/cancel")
    @require_user("administrator", "coordinator")
    @csrf_protected
    def cancel_match(match_id):
        db = get_db()
        try:
            db.execute("BEGIN IMMEDIATE")
            match = one("SELECT * FROM matches WHERE id=?", (match_id,))
            if not match or match["status"] not in {"confirmed", "proposed"}:
                raise ValueError("Only a proposed or confirmed match can be cancelled.")
            db.execute("UPDATE matches SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=?",
                       (now_iso(), now_iso(), match_id))
            delivery = one("SELECT id FROM deliveries WHERE match_id=?", (match_id,))
            if delivery:
                db.execute("UPDATE deliveries SET status='cancelled',updated_at=? WHERE id=?", (now_iso(), delivery["id"]))
            donation = one("SELECT * FROM donations WHERE id=?", (match["donation_id"],))
            request_row = one("SELECT * FROM food_requests WHERE id=?", (match["request_id"],))
            reserved = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE donation_id=? AND status='confirmed'",
                           (donation["id"],))["total"]
            db.execute("UPDATE donations SET status=?,updated_at=? WHERE id=?",
                       ("matched" if reserved else ("approved" if donation["review_status"] == "approved" else "under_review"), now_iso(), donation["id"]))
            fulfilled = one("SELECT COALESCE(SUM(proposed_quantity),0) AS total FROM matches WHERE request_id=? AND status='confirmed'",
                            (request_row["id"],))["total"]
            req_status = "fulfilled" if fulfilled >= request_row["quantity"] else ("partially_fulfilled" if fulfilled else "open")
            db.execute("UPDATE food_requests SET status=?,updated_at=? WHERE id=?", (req_status, now_iso(), request_row["id"]))
            audit("match_cancelled", "match", match_id, {"released_quantity": match["proposed_quantity"], "unit": match["unit"]})
            db.execute("COMMIT")
            return jsonify({"ok": True})
        except ValueError as error:
            if db.in_transaction:
                db.execute("ROLLBACK")
            return api_error(str(error))

    @app.patch("/api/deliveries/<delivery_id>/status")
    @require_user("administrator", "coordinator", "driver")
    @csrf_protected
    def update_delivery_status(delivery_id):
        delivery = scoped_delivery(delivery_id)
        if not delivery:
            return api_error("Delivery not found or not assigned to you.", 404)
        data = payload()
        status = data.get("status")
        if session["user"]["role"] == "driver" and status not in {
            "pickup_in_progress", "collected", "in_transit", "pickup_failed", "delayed", "unresolved",
        }:
            return api_error("Drivers can only record pickup and transport progress.", 403)
        try:
            record_status(delivery_id, status, data.get("quantity_collected"))
            if status in {"delayed", "pickup_failed", "unresolved"}:
                notify_roles(COORDINATORS, "Delivery needs attention", f"Delivery {delivery_id[:8]} is {status.replace('_',' ')}.", "delivery", delivery_id)
            return jsonify({"ok": True})
        except (ValueError, TypeError) as error:
            return api_error(str(error))

    @app.post("/api/deliveries/<delivery_id>/issues")
    @require_user("administrator", "coordinator", "donor", "partner", "driver")
    @csrf_protected
    def report_delivery_issue(delivery_id):
        delivery = scoped_delivery(delivery_id)
        if not delivery:
            return api_error("Delivery not found or not assigned to you.", 404)
        data = payload()
        try:
            required(data, ["category", "description"])
            issue_id = new_id()
            get_db().execute(
                """INSERT INTO delivery_issues (id,delivery_id,category,description,follow_up_action,created_by,assigned_to)
                   VALUES (?,?,?,?,?,?,?)""",
                (issue_id, delivery_id, str(data["category"]).strip(), str(data["description"]).strip(),
                 str(data.get("follow_up_action", "")).strip(), session["user"]["id"], delivery["coordinator_id"]),
            )
            audit("delivery_issue_reported", "delivery", delivery_id, {"issue_id": issue_id, "category": data["category"]})
            notify_profiles([delivery["coordinator_id"]], "Delivery issue reported", str(data["description"]), "issue", issue_id)
            return jsonify({"id": issue_id}), 201
        except ValueError as error:
            return api_error(str(error))

    @app.post("/api/deliveries/<delivery_id>/confirm")
    @require_user("partner", "administrator", "coordinator")
    @csrf_protected
    def confirm_delivery(delivery_id):
        delivery = scoped_delivery(delivery_id)
        if not delivery:
            return api_error("Delivery not found or not assigned to your organization.", 404)
        data = payload()
        try:
            required(data, ["quantity_received", "condition_on_arrival", "acceptance"])
            received = float(data["quantity_received"])
            if not math.isfinite(received) or received < 0:
                raise ValueError("Received quantity cannot be negative.")
            acceptance = data["acceptance"]
            if acceptance not in {"accepted", "partially_accepted", "rejected"}:
                raise ValueError("Choose accepted, partially accepted, or rejected.")
            if acceptance == "accepted" and received != delivery["quantity_expected"]:
                raise ValueError("Use partial acceptance when the quantity differs from the expected quantity.")
            if acceptance == "rejected" and received != 0:
                raise ValueError("A rejected delivery must have zero accepted quantity.")
            db = get_db()
            db.execute("BEGIN IMMEDIATE")
            previous = one("SELECT id FROM delivery_confirmations WHERE delivery_id=? ORDER BY created_at DESC LIMIT 1", (delivery_id,))
            if previous and data.get("is_correction") is not True:
                raise ValueError("A receipt already exists. Mark this as a correction to preserve the confirmation history.")
            if not previous and data.get("is_correction") is True:
                raise ValueError("There is no earlier receipt to correct.")
            if delivery["status"] not in {"in_transit", "partially_delivered", "rejected_on_arrival", "unresolved"} and not previous:
                raise ValueError("The driver must record collection and in-transit progress before receipt can be confirmed.")
            confirmation_id = new_id()
            db.execute(
                """INSERT INTO delivery_confirmations (id,delivery_id,confirmed_by,quantity_expected,quantity_received,unit,
                    condition_on_arrival,acceptance,correction_of) VALUES (?,?,?,?,?,?,?,?,?)""",
                (confirmation_id, delivery_id, session["user"]["id"], delivery["quantity_expected"], received, delivery["unit"],
                 data["condition_on_arrival"].strip(), acceptance, previous["id"] if data.get("is_correction") and previous else None),
            )
            discrepancy = received != delivery["quantity_expected"] or acceptance != "accepted"
            new_status = "delivered" if acceptance == "accepted" else ("partially_delivered" if acceptance == "partially_accepted" else "rejected_on_arrival")
            db.execute("UPDATE deliveries SET quantity_received=?,status=?,confirmation_at=?,updated_at=? WHERE id=?",
                       (received, new_status, now_iso(), now_iso(), delivery_id))
            if discrepancy:
                issue_id = new_id()
                description = str(data.get("issue_description") or f"Expected {delivery['quantity_expected']} {delivery['unit']}; received {received} {delivery['unit']}.").strip()
                db.execute(
                    """INSERT INTO delivery_issues (id,delivery_id,category,description,follow_up_action,created_by,assigned_to)
                       VALUES (?,?,?,?,?,?,?)""",
                    (issue_id, delivery_id, data.get("issue_category", "quantity_discrepancy"), description,
                     data.get("follow_up_action", "").strip(), session["user"]["id"], delivery["coordinator_id"]),
                )
                notify_profiles([delivery["coordinator_id"]], "Delivery discrepancy reported", description, "issue", issue_id)
                audit("delivery_discrepancy_reported", "delivery", delivery_id,
                      {"expected": delivery["quantity_expected"], "received": received, "issue_id": issue_id})
            else:
                audit("delivery_confirmation_corrected" if previous else "delivery_confirmed", "delivery", delivery_id,
                      {"received": received, "unit": delivery["unit"], "corrects": previous["id"] if previous else None})
            db.execute("COMMIT")
            return jsonify({"ok": True, "discrepancy": discrepancy, "confirmation_id": confirmation_id}), 201
        except ValueError as error:
            if get_db().in_transaction:
                get_db().execute("ROLLBACK")
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            if get_db().in_transaction:
                get_db().execute("ROLLBACK")
            return api_error(f"Confirmation could not be saved: {error}")

    @app.get("/api/deliveries/<delivery_id>/timeline")
    @require_user()
    def delivery_timeline(delivery_id):
        delivery = scoped_delivery(delivery_id)
        if not delivery:
            return api_error("Delivery not found or not assigned to you.", 404)
        timeline = rows(
            """SELECT a.action,a.details,a.created_at,p.full_name FROM activity_logs a LEFT JOIN profiles p ON p.id=a.profile_id
               WHERE a.entity_type='delivery' AND a.entity_id=? ORDER BY a.created_at""",
            (delivery_id,),
        )
        confirmations = rows(
            """SELECT 'delivery_confirmation' AS action,condition_on_arrival AS details,confirmation_at AS created_at,
                      p.full_name FROM delivery_confirmations c JOIN profiles p ON p.id=c.confirmed_by
               WHERE c.delivery_id=? ORDER BY confirmation_at""",
            (delivery_id,),
        )
        for entry in confirmations:
            entry["details"] = json.dumps({"condition": entry["details"]})
        return jsonify({"delivery": delivery, "timeline": sorted(timeline + confirmations, key=lambda item: item["created_at"])})

    @app.patch("/api/issues/<issue_id>")
    @require_user("administrator", "coordinator")
    @csrf_protected
    def update_issue(issue_id):
        issue = one("SELECT * FROM delivery_issues WHERE id=?", (issue_id,))
        if not issue:
            return api_error("Issue not found.", 404)
        data = payload()
        status = data.get("status", issue["status"])
        if status not in ISSUE_STATUSES:
            return api_error("Choose a valid issue status.")
        db = get_db()
        db.execute("UPDATE delivery_issues SET status=?,follow_up_action=?,assigned_to=?,updated_at=? WHERE id=?",
                   (status, data.get("follow_up_action", issue["follow_up_action"]), data.get("assigned_to", issue["assigned_to"]), now_iso(), issue_id))
        audit("issue_status_changed", "issue", issue_id, {"from": issue["status"], "to": status})
        return jsonify({"ok": True})

    @app.post("/api/feedback")
    @require_user("partner")
    @csrf_protected
    def submit_feedback():
        data = payload()
        try:
            values = [int(data.get(key, 0)) for key in ("ease_rating", "communication_rating", "reliability_rating")]
            if any(value < 1 or value > 5 for value in values):
                raise ValueError("Rate ease of use, communication, and reliability from 1 to 5.")
        except (ValueError, TypeError):
            return api_error("Rate ease of use, communication, and reliability from 1 to 5.")
        feedback_id = new_id()
        get_db().execute(
            """INSERT INTO partner_feedback (id,organization_id,profile_id,ease_rating,communication_rating,reliability_rating,comment)
               VALUES (?,?,?,?,?,?,?)""",
            (feedback_id, session["user"]["organization_id"], session["user"]["id"], *values, str(data.get("comment", "")).strip()),
        )
        audit("partner_feedback_submitted", "feedback", feedback_id)
        return jsonify({"id": feedback_id}), 201

    @app.post("/api/organizations")
    @require_user("administrator")
    @csrf_protected
    def create_organization():
        data = payload()
        try:
            required(data, ["name", "type"])
            if data["type"] not in {"donor", "community_partner", "transport", "pilot"}:
                raise ValueError("Choose a valid organization type.")
            organization_id = new_id()
            get_db().execute(
                """INSERT INTO organizations (id,name,type,contact_name,contact_email,contact_phone,service_area,capabilities,notes)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (organization_id, data["name"].strip(), data["type"], str(data.get("contact_name", "")).strip(),
                 str(data.get("contact_email", "")).strip(), str(data.get("contact_phone", "")).strip(),
                 str(data.get("service_area", "")).strip(), str(data.get("capabilities", "")).strip(),
                 str(data.get("notes", "")).strip()),
            )
            audit("organization_registered", "organization", organization_id, {"type": data["type"]})
            return jsonify({"id": organization_id}), 201
        except ValueError as error:
            return api_error(str(error))
        except sqlite3.IntegrityError as error:
            return api_error(f"Organization could not be registered: {error}")

    @app.post("/api/team")
    @require_user("administrator")
    @csrf_protected
    def create_team_member():
        data = payload()
        try:
            required(data, ["email", "full_name", "role", "organization_id", "password"])
            role = data["role"]
            if role not in ROLES:
                raise ValueError("Choose a valid team role.")
            password = data["password"]
            if not isinstance(password, str) or len(password) < 12:
                raise ValueError("Set an initial password with at least 12 characters.")
            if "@" not in data["email"] or "." not in data["email"].rsplit("@", 1)[-1]:
                raise ValueError("Enter a valid email address.")
            organization = one("SELECT type FROM organizations WHERE id=?", (data["organization_id"],))
            expected_type = {"donor": "donor", "partner": "community_partner", "driver": "transport"}.get(role)
            if not organization or (expected_type and organization["type"] != expected_type):
                raise ValueError("The selected organization does not match the requested role.")
            if role in {"administrator", "coordinator"} and organization["type"] != "pilot":
                raise ValueError("The selected organization does not match the requested role.")
            profile_id = new_id()
            get_db().execute(
                "INSERT INTO profiles (id,email,password_hash,full_name,role,organization_id) VALUES (?,?,?,?,?,?)",
                (profile_id, data["email"].strip().lower(), generate_password_hash(password, method=app.config["PASSWORD_HASH_METHOD"]),
                 data["full_name"].strip(), role, data["organization_id"]),
            )
            audit("team_member_created", "profile", profile_id, {"role": role})
            return jsonify({"id": profile_id}), 201
        except ValueError as error:
            return api_error(str(error))
        except sqlite3.IntegrityError:
            return api_error("A profile already uses that email address.")

    @app.patch("/api/team/<profile_id>")
    @require_user("administrator")
    @csrf_protected
    def update_team_member(profile_id):
        if profile_id == session["user"]["id"]:
            return api_error("You cannot deactivate or change your own administrator account.")
        member = one("SELECT id,active,role FROM profiles WHERE id=?", (profile_id,))
        if not member:
            return api_error("Team member not found.", 404)
        data = payload()
        if not isinstance(data.get("active"), bool):
            return api_error("Set the account active state to true or false.")
        get_db().execute("UPDATE profiles SET active=? WHERE id=?", (int(data["active"]), profile_id))
        audit("team_member_access_changed", "profile", profile_id, {"active": data["active"]})
        return jsonify({"ok": True})

    @app.post("/api/notifications/<notification_id>/read")
    @require_user()
    @csrf_protected
    def mark_notification_read(notification_id):
        result = get_db().execute("UPDATE notifications SET read_at=? WHERE id=? AND profile_id=?",
                                  (now_iso(), notification_id, session["user"]["id"]))
        if result.rowcount == 0:
            return api_error("Notification not found.", 404)
        return jsonify({"ok": True})

    @app.patch("/api/settings")
    @require_user("administrator")
    @csrf_protected
    def update_settings():
        data = payload()
        allowed = {"pilot_name", "district", "start_date", "end_date", "accepted_categories", "accepted_units",
                   "safety_checklist", "scheduling_rules", "transport_capacity", "privacy_policy", "retention_policy"}
        values = {key: data[key] for key in allowed if key in data}
        if not values:
            return api_error("No settings were provided.")
        for key in ("accepted_categories", "accepted_units", "safety_checklist"):
            if key in values and not isinstance(values[key], (list, str)):
                return api_error(f"{key} must be a list or text.")
            if isinstance(values.get(key), list):
                values[key] = json.dumps(values[key])
        start_date, end_date = values.get("start_date"), values.get("end_date")
        if start_date and end_date and end_date < start_date:
            return api_error("Pilot end date must be on or after the start date.")
        assignments = ",".join(f"{key}=?" for key in values)
        get_db().execute(f"UPDATE pilot_settings SET {assignments},updated_at=? WHERE id=1", (*values.values(), now_iso()))
        audit("pilot_settings_updated", "pilot_settings", "1", {"fields": sorted(values)})
        return jsonify({"ok": True})

    @app.get("/api/reports.csv")
    @require_user("administrator", "coordinator")
    def export_report():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["delivery_id", "match_id", "donor", "community_partner", "category", "expected_quantity", "unit",
                         "received_quantity", "status", "scheduled_pickup", "scheduled_delivery", "confirmed_at"])
        clauses, params = [], []
        if request.args.get("date_from"):
            clauses.append("date(d.scheduled_pickup) >= date(?)")
            params.append(request.args["date_from"])
        if request.args.get("date_to"):
            clauses.append("date(d.scheduled_pickup) <= date(?)")
            params.append(request.args["date_to"])
        if request.args.get("organization_id"):
            clauses.append("(d.donor_organization_id=? OR d.receiving_organization_id=?)")
            params.extend((request.args["organization_id"], request.args["organization_id"]))
        if request.args.get("area"):
            clauses.append("(don.service_area=? OR rec.service_area=?)")
            params.extend((request.args["area"], request.args["area"]))
        if request.args.get("category"):
            clauses.append("donation.category=?")
            params.append(request.args["category"])
        filter_sql = " WHERE " + " AND ".join(clauses) if clauses else ""
        records = rows(
            """SELECT d.id,d.match_id,don.name AS donor,rec.name AS partner,donation.category,
                      d.quantity_expected,donation.unit,d.quantity_received,d.status,d.scheduled_pickup,
                      d.scheduled_delivery,d.confirmation_at
               FROM deliveries d JOIN organizations don ON don.id=d.donor_organization_id
               JOIN organizations rec ON rec.id=d.receiving_organization_id JOIN matches m ON m.id=d.match_id
               JOIN donations donation ON donation.id=m.donation_id""" + filter_sql + " ORDER BY d.scheduled_pickup", params
        )
        for record in records:
            writer.writerow([record[key] if record[key] is not None else "" for key in (
                "id", "match_id", "donor", "partner", "category", "quantity_expected", "unit",
                "quantity_received", "status", "scheduled_pickup", "scheduled_delivery", "confirmation_at")])
        response = make_response(output.getvalue())
        response.headers["Content-Type"] = "text/csv; charset=utf-8"
        response.headers["Content-Disposition"] = 'attachment; filename="foodlink-pilot-report.csv"'
        return response

    @app.get("/api/reports")
    @require_user("administrator", "coordinator")
    def reports():
        clauses = []
        params = []
        date_from = request.args.get("date_from")
        date_to = request.args.get("date_to")
        organization_id = request.args.get("organization_id")
        area = request.args.get("area")
        category_filter = request.args.get("category")
        if date_from:
            clauses.append("date(d.scheduled_pickup) >= date(?)")
            params.append(date_from)
        if date_to:
            clauses.append("date(d.scheduled_pickup) <= date(?)")
            params.append(date_to)
        if organization_id:
            clauses.append("(d.donor_organization_id=? OR d.receiving_organization_id=?)")
            params.extend((organization_id, organization_id))
        if area:
            clauses.append("(donor.service_area=? OR receiver.service_area=?)")
            params.extend((area, area))
        if category_filter:
            clauses.append("donation.category=?")
            params.append(category_filter)
        filter_sql = " WHERE " + " AND ".join(clauses) if clauses else ""
        deliveries = rows("""SELECT d.*,m.confirmed_at,donation.submitted_at,donation.category,donation.unit AS donation_unit,
                                    donor.name AS donor_name,receiver.name AS partner_name,receiver.service_area
                             FROM deliveries d JOIN matches m ON m.id=d.match_id
                             JOIN donations donation ON donation.id=m.donation_id
                             JOIN organizations donor ON donor.id=d.donor_organization_id
                             JOIN organizations receiver ON receiver.id=d.receiving_organization_id""" + filter_sql +
                           " ORDER BY d.scheduled_pickup", params)
        totals = {}
        for delivery in deliveries:
            key = (delivery["category"], delivery["donation_unit"])
            item = totals.setdefault(key, {"category": key[0], "unit": key[1], "quantity_delivered": 0, "unknown_quantity_count": 0})
            if delivery["quantity_received"] is None:
                item["unknown_quantity_count"] += 1
            else:
                item["quantity_delivered"] += delivery["quantity_received"]
        confirmed_matches = sum(1 for item in deliveries if item["confirmed_at"])
        completed_deliveries = sum(1 for item in deliveries if item["status"] == "delivered" and item["confirmed_at"])
        pickup_durations, travel_durations = [], []
        collection_events = rows(
            """SELECT entity_id,MIN(created_at) AS collected_at FROM activity_logs
               WHERE entity_type='delivery' AND action='delivery_status_changed'
                 AND details LIKE '%"to": "collected"%' GROUP BY entity_id"""
        )
        collected_at_by_delivery = {event["entity_id"]: event["collected_at"] for event in collection_events}
        for delivery in deliveries:
            try:
                start = datetime.fromisoformat(delivery["submitted_at"].replace("Z", "+00:00"))
                actual_pickup = collected_at_by_delivery.get(delivery["id"])
                if actual_pickup:
                    pickup = datetime.fromisoformat(actual_pickup.replace("Z", "+00:00"))
                    pickup_durations.append((pickup - start).total_seconds() / 3600)
                if actual_pickup and delivery["confirmation_at"]:
                    pickup = datetime.fromisoformat(actual_pickup.replace("Z", "+00:00"))
                    delivered = datetime.fromisoformat(delivery["confirmation_at"].replace("Z", "+00:00"))
                    travel_durations.append((delivered - pickup).total_seconds() / 3600)
            except (ValueError, TypeError):
                continue
        overdue_clauses = ["r.status IN ('open','partially_fulfilled')", "r.required_by < ?"]
        overdue_params = [now_iso()]
        if organization_id:
            overdue_clauses.append("r.organization_id=?")
            overdue_params.append(organization_id)
        if area:
            overdue_clauses.append("o.service_area=?")
            overdue_params.append(area)
        if category_filter:
            overdue_clauses.append("EXISTS (SELECT 1 FROM json_each(r.categories) WHERE value=?)")
            overdue_params.append(category_filter)
        if date_from:
            overdue_clauses.append("date(r.required_by) >= date(?)")
            overdue_params.append(date_from)
        if date_to:
            overdue_clauses.append("date(r.required_by) <= date(?)")
            overdue_params.append(date_to)
        overdue = one("""SELECT COUNT(*) AS count FROM food_requests r JOIN organizations o ON o.id=r.organization_id
                         WHERE """ + " AND ".join(overdue_clauses), overdue_params)["count"]
        unmatched_clauses = ["d.status IN ('rejected','cancelled','unresolved')"]
        unmatched_params = []
        if category_filter:
            unmatched_clauses.append("d.category=?")
            unmatched_params.append(category_filter)
        unmatched = rows("""SELECT d.category,d.unit,SUM(d.quantity) AS quantity FROM donations d
                            WHERE """ + " AND ".join(unmatched_clauses) + " GROUP BY d.category,d.unit", unmatched_params)
        organizations_in_view = set()
        for item in deliveries:
            organizations_in_view.add(item["donor_organization_id"])
            organizations_in_view.add(item["receiving_organization_id"])
        if organization_id:
            organizations_in_view.add(organization_id)
        if organizations_in_view:
            placeholders = ",".join("?" for _ in organizations_in_view)
            areas = rows(f"""SELECT service_area,COUNT(*) AS organizations FROM organizations
                             WHERE participation_status='active' AND id IN ({placeholders}) GROUP BY service_area""",
                         list(organizations_in_view))
        else:
            areas = []
        feedback_where, feedback_params = [], []
        if organization_id:
            feedback_where.append("organization_id=?")
            feedback_params.append(organization_id)
        feedback_filter = " WHERE " + " AND ".join(feedback_where) if feedback_where else ""
        feedback = one("""SELECT COUNT(*) AS responses,AVG(ease_rating) AS ease,AVG(communication_rating) AS communication,
                                 AVG(reliability_rating) AS reliability FROM partner_feedback""" + feedback_filter,
                       feedback_params)
        status_counts_map = {}
        category_map = {}
        time_series_map = {}
        for item in deliveries:
            status_counts_map[item["status"]] = status_counts_map.get(item["status"], 0) + 1
            key = (item["category"], item["donation_unit"])
            grouped = category_map.setdefault(key, {"category": key[0], "unit": key[1], "received": 0, "unknown": 0})
            if item["quantity_received"] is None:
                grouped["unknown"] += 1
            else:
                grouped["received"] += item["quantity_received"]
            if item["status"] == "delivered" and item["confirmation_at"]:
                day = item["confirmation_at"][:10]
                time_series_map[day] = time_series_map.get(day, 0) + 1
        status_counts = [{"status": key, "count": value} for key, value in status_counts_map.items()]
        categories = list(category_map.values())
        activities = rows("SELECT action,entity_type,created_at FROM activity_logs ORDER BY created_at DESC LIMIT 50")
        return jsonify({
            "delivery_completion_rate": (completed_deliveries / confirmed_matches * 100) if confirmed_matches else None,
            "completion_count": completed_deliveries, "confirmed_match_count": confirmed_matches,
            "total_delivered_by_category_unit": list(totals.values()),
            "timeliness_hours": {"submission_to_pickup": pickup_durations, "pickup_to_delivery": travel_durations},
            "unmatched_food_by_category_unit": unmatched, "unmet_request_count": overdue,
            "partner_coverage": {"organizations": one("SELECT COUNT(*) AS count FROM organizations WHERE participation_status='active'")["count"], "areas": areas},
            "partner_feedback": feedback, "delivery_statuses": status_counts, "category_breakdown": categories,
            "time_series": [{"date": key, "completed_deliveries": value} for key, value in sorted(time_series_map.items())],
            "activity": activities, "missing_data": {
                "received_quantities_unknown": sum(1 for item in deliveries if item["quantity_received"] is None),
                "operational_effort": "Coordinator hours and transport costs are not yet recorded.",
                "unusable_food": "Spoilage is not tracked separately from delivery issues in this pilot dataset.",
            },
        })

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG") == "1")
