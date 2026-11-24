import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "data" / "clinic.db"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
if not SESSION_SECRET:
    SESSION_SECRET = secrets.token_urlsafe(32)
    if ADMIN_PASSWORD:
        print("SESSION_SECRET is unset; staff sessions will expire when the server restarts.")

DEPARTMENTS = (
    ("general", "General Medicine", "GM"),
    ("pediatrics", "Pediatrics", "PD"),
    ("dental", "Dental Care", "DT"),
    ("eye", "Eye Care", "EC"),
    ("women", "Women's Health", "WH"),
)
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
    "/sw.js": "sw.js",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/icon.svg": "icon.svg",
}


@contextmanager
def connect_db():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_db():
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS departments (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prefix TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                service_date TEXT NOT NULL,
                token_number INTEGER NOT NULL,
                name TEXT NOT NULL,
                age INTEGER NOT NULL,
                gender TEXT NOT NULL,
                phone TEXT NOT NULL,
                village TEXT NOT NULL,
                department_id TEXT NOT NULL REFERENCES departments(id),
                request_id TEXT,
                status TEXT NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'called', 'completed')),
                created_at TEXT NOT NULL,
                UNIQUE(service_date, department_id, token_number)
            );
            CREATE INDEX IF NOT EXISTS patients_queue
                ON patients(service_date, department_id, status, id);
            CREATE TABLE IF NOT EXISTS camps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                camp_date TEXT NOT NULL,
                location TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            """
        )
        columns = {
            row["name"] for row in db.execute("PRAGMA table_info(patients)").fetchall()
        }
        if "request_id" not in columns:
            db.execute("ALTER TABLE patients ADD COLUMN request_id TEXT")
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS patients_request_id ON patients(request_id)"
        )
        db.executemany(
            "INSERT OR IGNORE INTO departments (id, name, prefix) VALUES (?, ?, ?)",
            DEPARTMENTS,
        )


def public_ticket(row, position):
    return {
        "id": row["id"],
        "token": row["token"],
        "name": row["name"],
        "department": row["department"],
        "status": row["status"],
        "position": position,
        "createdAt": row["created_at"],
    }


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class QueueHandler(BaseHTTPRequestHandler):
    server_version = "CommunityQueue/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def send_json(self, status, value, headers=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; object-src 'none'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        )
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid request body.")
        if length < 1 or length > 16_384:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Request body is missing or too large.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Request body must be valid JSON.")
        if not isinstance(payload, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object.")
        return payload

    def require_admin(self):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
            token = cookies["staff_session"].value
            issued, signature = token.split(".", 1)
            expected = hmac.new(
                SESSION_SECRET.encode(), issued.encode(), hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError("Invalid signature")
            if int(issued) < int(time.time()) - 8 * 60 * 60:
                raise ValueError("Expired session")
        except (KeyError, ValueError):
            raise RequestError(HTTPStatus.UNAUTHORIZED, "Please sign in as staff.")

    def handle_api(self, method, path, query):
        if method == "GET" and path == "/api/departments":
            with connect_db() as db:
                rows = db.execute("SELECT id, name FROM departments ORDER BY name").fetchall()
            return self.send_json(HTTPStatus.OK, [dict(row) for row in rows])

        if method == "GET" and path == "/api/camps":
            with connect_db() as db:
                rows = db.execute(
                    """
                    SELECT id, title, camp_date AS date, location, details
                    FROM camps WHERE camp_date >= ? ORDER BY camp_date, id
                    """,
                    (date.today().isoformat(),),
                ).fetchall()
            return self.send_json(HTTPStatus.OK, [dict(row) for row in rows])

        if method == "GET" and path == "/api/queue":
            service_date = date.today().isoformat()
            with connect_db() as db:
                rows = db.execute(
                    """
                    SELECT d.id, d.name,
                        (SELECT COUNT(*) FROM patients p
                         WHERE p.department_id = d.id AND p.service_date = ?
                           AND p.status = 'waiting') AS waiting,
                        (SELECT p.token FROM patients p
                         WHERE p.department_id = d.id AND p.service_date = ?
                           AND p.status = 'called' ORDER BY p.id DESC LIMIT 1) AS current,
                        (SELECT p.token FROM patients p
                         WHERE p.department_id = d.id AND p.service_date = ?
                           AND p.status = 'waiting' ORDER BY p.id LIMIT 1) AS next
                    FROM departments d ORDER BY d.name
                    """,
                    (service_date, service_date, service_date),
                ).fetchall()
            return self.send_json(HTTPStatus.OK, [dict(row) for row in rows])

        if method == "POST" and path == "/api/ticket":
            payload = self.read_json()
            token = str(payload.get("token", "")).strip().upper()
            phone = "".join(c for c in str(payload.get("phone", "")) if c.isdigit())
            if not token or not phone:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Enter your token and phone number.")
            with connect_db() as db:
                row = db.execute(
                    """
                    SELECT p.id, p.token, p.name, d.name AS department, p.status,
                           p.created_at, p.service_date, p.phone
                    FROM patients p JOIN departments d ON d.id = p.department_id
                    WHERE p.token = ? AND p.phone = ?
                    """,
                    (token, phone),
                ).fetchone()
                if row is None:
                    raise RequestError(HTTPStatus.NOT_FOUND, "We couldn't find that token and phone number.")
                position = 0
                if row["status"] == "waiting":
                    position = db.execute(
                        """
                        SELECT COUNT(*) + 1 AS position FROM patients
                        WHERE service_date = ? AND department_id = (
                            SELECT department_id FROM patients WHERE id = ?
                        ) AND status = 'waiting' AND id < ?
                        """,
                        (row["service_date"], row["id"], row["id"]),
                    ).fetchone()["position"]
            return self.send_json(HTTPStatus.OK, public_ticket(row, position))

        if method == "POST" and path == "/api/register":
            payload = self.read_json()
            name = str(payload.get("name", "")).strip()
            age = payload.get("age")
            gender = str(payload.get("gender", "")).strip()
            phone = "".join(c for c in str(payload.get("phone", "")) if c.isdigit())
            village = str(payload.get("village", "")).strip()
            department_id = str(payload.get("department", "")).strip()
            request_id = str(payload.get("requestId", "")).strip()
            if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", request_id):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Registration request is missing a valid ID.")
            if not name or len(name) > 100:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a name up to 100 characters.")
            if isinstance(age, bool) or not str(age).isdigit() or not 0 <= int(age) <= 120:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a valid age from 0 to 120.")
            if gender not in ("Female", "Male", "Other", "Prefer not to say"):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Select a gender option.")
            if not 7 <= len(phone) <= 15:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a valid phone number.")
            if not village or len(village) > 120:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a village or address up to 120 characters.")
            service_date = date.today().isoformat()
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            with connect_db() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute(
                    """
                    SELECT p.id, p.token, p.name, d.name AS department, p.status,
                           p.created_at, p.service_date, p.department_id
                    FROM patients p JOIN departments d ON d.id = p.department_id
                    WHERE p.request_id = ?
                    """,
                    (request_id,),
                ).fetchone()
                if existing is not None:
                    position = 0
                    if existing["status"] == "waiting":
                        position = db.execute(
                            """
                            SELECT COUNT(*) + 1 AS position FROM patients
                            WHERE service_date = ? AND department_id = ?
                              AND status = 'waiting' AND id < ?
                            """,
                            (existing["service_date"], existing["department_id"], existing["id"]),
                        ).fetchone()["position"]
                    return self.send_json(
                        HTTPStatus.OK, public_ticket(existing, position)
                    )
                department = db.execute(
                    "SELECT prefix, name FROM departments WHERE id = ?", (department_id,)
                ).fetchone()
                if department is None:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Select a valid department.")
                number = db.execute(
                    """
                    SELECT COALESCE(MAX(token_number), 0) + 1 AS number FROM patients
                    WHERE service_date = ? AND department_id = ?
                    """,
                    (service_date, department_id),
                ).fetchone()["number"]
                token = "%s-%03d" % (department["prefix"], number)
                cursor = db.execute(
                    """
                    INSERT INTO patients
                        (token, service_date, token_number, name, age, gender, phone,
                         village, department_id, request_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (token, service_date, number, name, int(age), gender, phone,
                     village, department_id, request_id, now),
                )
                row = db.execute(
                    """
                    SELECT p.id, p.token, p.name, d.name AS department, p.status,
                           p.created_at
                    FROM patients p JOIN departments d ON d.id = p.department_id
                    WHERE p.id = ?
                    """,
                    (cursor.lastrowid,),
                ).fetchone()
                position = db.execute(
                    "SELECT COUNT(*) AS position FROM patients WHERE service_date = ? "
                    "AND department_id = ? AND status = 'waiting'",
                    (service_date, department_id),
                ).fetchone()["position"]
            return self.send_json(HTTPStatus.CREATED, public_ticket(row, position))

        if path == "/api/admin/login" and method == "POST":
            payload = self.read_json()
            if not ADMIN_PASSWORD:
                raise RequestError(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "Staff sign-in is disabled. Set ADMIN_PASSWORD on the server.",
                )
            supplied = str(payload.get("password", ""))
            if not hmac.compare_digest(supplied.encode(), ADMIN_PASSWORD.encode()):
                raise RequestError(HTTPStatus.UNAUTHORIZED, "Incorrect staff password.")
            issued = str(int(time.time()))
            signature = hmac.new(
                SESSION_SECRET.encode(), issued.encode(), hashlib.sha256
            ).hexdigest()
            cookie = "staff_session=%s.%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800" % (
                issued, signature
            )
            if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
                cookie += "; Secure"
            return self.send_json(
                HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie}
            )

        if path == "/api/admin/logout" and method == "POST":
            return self.send_json(
                HTTPStatus.OK,
                {"ok": True},
                {"Set-Cookie": "staff_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"},
            )

        if path.startswith("/api/admin/"):
            self.require_admin()
            if method == "GET" and path == "/api/admin/session":
                return self.send_json(HTTPStatus.OK, {"authenticated": True, "role": "admin"})
            if method == "GET" and path == "/api/admin/patients":
                with connect_db() as db:
                    rows = db.execute(
                        """
                        SELECT p.id, p.token, p.name, p.age, p.gender, p.phone, p.village,
                               p.status, p.created_at, d.name AS department
                        FROM patients p JOIN departments d ON d.id = p.department_id
                        WHERE p.service_date = ? ORDER BY p.id
                        """,
                        (date.today().isoformat(),),
                    ).fetchall()
                return self.send_json(HTTPStatus.OK, [dict(row) for row in rows])

            if method == "GET" and path == "/api/admin/camps":
                with connect_db() as db:
                    rows = db.execute(
                        """
                        SELECT id, title, camp_date AS date, location
                        FROM camps WHERE camp_date >= ? ORDER BY camp_date, id
                        """,
                        (date.today().isoformat(),),
                    ).fetchall()
                return self.send_json(HTTPStatus.OK, [dict(row) for row in rows])

            if method == "POST" and path == "/api/admin/camps":
                payload = self.read_json()
                title = str(payload.get("title", "")).strip()
                camp_date = str(payload.get("date", "")).strip()
                location = str(payload.get("location", "")).strip()
                details = str(payload.get("details", "")).strip()
                try:
                    parsed_date = date.fromisoformat(camp_date)
                except ValueError:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Choose a valid camp date.")
                if parsed_date.isoformat() != camp_date:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Choose a valid camp date.")
                if parsed_date < date.today():
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Camp date cannot be in the past.")
                if not title or len(title) > 100:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a camp title up to 100 characters.")
                if not location or len(location) > 160:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Enter a location up to 160 characters.")
                if len(details) > 500:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Camp details must be 500 characters or fewer.")
                with connect_db() as db:
                    cursor = db.execute(
                        """
                        INSERT INTO camps (title, camp_date, location, details, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            title,
                            camp_date,
                            location,
                            details,
                            datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        ),
                    )
                return self.send_json(
                    HTTPStatus.CREATED,
                    {"id": cursor.lastrowid, "title": title, "date": camp_date, "location": location},
                )

            if method == "POST" and path == "/api/admin/camps/delete":
                payload = self.read_json()
                try:
                    camp_id = int(payload.get("id"))
                except (TypeError, ValueError):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Select a valid camp.")
                with connect_db() as db:
                    cursor = db.execute("DELETE FROM camps WHERE id = ?", (camp_id,))
                    if cursor.rowcount == 0:
                        raise RequestError(HTTPStatus.NOT_FOUND, "That camp is no longer available.")
                return self.send_json(HTTPStatus.OK, {"ok": True})

            if method == "POST" and path == "/api/admin/call-next":
                payload = self.read_json()
                department_id = str(payload.get("department", "")).strip()
                with connect_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    sql = (
                        "SELECT id, token FROM patients WHERE service_date = ? "
                        "AND status = 'waiting'"
                    )
                    params = [date.today().isoformat()]
                    if department_id:
                        sql += " AND department_id = ?"
                        params.append(department_id)
                    row = db.execute(sql + " ORDER BY id LIMIT 1", params).fetchone()
                    if row is None:
                        raise RequestError(HTTPStatus.NOT_FOUND, "There are no patients waiting.")
                    db.execute("UPDATE patients SET status = 'called' WHERE id = ?", (row["id"],))
                return self.send_json(HTTPStatus.OK, {"id": row["id"], "token": row["token"]})

            if method == "POST" and path == "/api/admin/complete":
                payload = self.read_json()
                try:
                    patient_id = int(payload.get("id"))
                except (TypeError, ValueError):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Select a valid patient.")
                with connect_db() as db:
                    cursor = db.execute(
                        """
                        UPDATE patients SET status = 'completed'
                        WHERE id = ? AND service_date = ? AND status = 'called'
                        """,
                        (patient_id, date.today().isoformat()),
                    )
                    if cursor.rowcount == 0:
                        raise RequestError(HTTPStatus.CONFLICT, "That patient is no longer being served.")
                return self.send_json(HTTPStatus.OK, {"ok": True})

        raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")

    def serve_static(self, path, head=False):
        filename = STATIC_FILES.get(path)
        if filename is None:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
        requested = ROOT / filename
        if not requested.is_file():
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
        body = requested.read_bytes()
        content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
        if requested.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") or content_type in ("application/javascript", "application/manifest+json") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; object-src 'none'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        )
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        if requested.name == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def dispatch(self, method):
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self.handle_api(method, path, query)
            elif method in ("GET", "HEAD"):
                self.serve_static(path, head=method == "HEAD")
            else:
                self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Method not allowed."})
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            print("Request failed: %s" % error)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "An internal server error occurred."})

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("HEAD")

    def do_POST(self):
        self.dispatch("POST")


if __name__ == "__main__":
    initialize_db()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), QueueHandler)
    print("Community Queue listening on http://%s:%s" % (host, port))
    if not ADMIN_PASSWORD:
        print("Staff sign-in is disabled. Set ADMIN_PASSWORD to enable staff controls.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Community Queue.")
    finally:
        server.server_close()
