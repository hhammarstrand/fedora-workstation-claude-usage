#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline-tester för bin/claude-usage.

Kör skriptet som en riktig subprocess mot en lokal stubbserver, så att det som
testas är exakt det CLI som tillägget anropar. Inga nätverksanrop utanför
localhost, inga beroenden utanför stdlib.

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO_ROOT, "bin", "claude-usage")

TOKEN = "sk-ant-oat01-TOPSECRET-TOKEN-VALUE-do-not-log"

# Formen som är publikt rapporterad, plus två nycklar parsern aldrig sett förut
# och en nyckel utan utilization — inget av det får krascha eller tappas bort.
SAMPLE = {
    "five_hour": {"utilization": 42, "resets_at": "2026-08-11T22:00:00Z"},
    "seven_day": {"utilization": 67, "resets_at": "2026-08-15T09:30:00+00:00"},
    "seven_day_opus": {"utilization": 91.5, "resets_at": "2026-08-15T09:30:00Z"},
    "seven_day_cowork": {"utilization": 0, "resets_at": "2026-08-15T09:30:00Z"},
    "thirty_day_fable": {"utilization": 12, "resets_at": 1786000000},
    "wibble_frotz": {"utilization": 5, "resets_at": None},
    "extra_usage": {"used_credits": 1.5, "credit_limit": 25, "enabled": True},
    "account_uuid": "abc-123",
    "some_unparsed_object": {"note": "no utilization here"},
}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        server = self.server
        server.requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "beta": self.headers.get("anthropic-beta"),
                "user_agent": self.headers.get("User-Agent"),
            }
        )
        status, content_type, body = server.responder(len(server.requests))
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if status == 429:
            self.send_header("Retry-After", "37")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # tysta testutdata
        pass


class StubServer:
    def __init__(self, responder):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.responder = responder
        self.httpd.requests = []
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        host, port = self.httpd.server_address[:2]
        return "http://%s:%d/api/oauth/usage" % (host, port)

    @property
    def requests(self):
        return self.httpd.requests

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def ok_json(_n):
    return 200, "application/json", json.dumps(SAMPLE)


class UsageTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="claude-usage-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        self.runtime = os.path.join(self.tmp, "runtime")
        os.makedirs(self.runtime, mode=0o700)

        self.creds = os.path.join(self.tmp, "credentials.json")
        self.write_creds(TOKEN, expires_at=4_000_000_000_000)

        self.server = None

    def write_creds(self, token, expires_at=4_000_000_000_000, raw=None):
        with open(self.creds, "w", encoding="utf-8") as fh:
            if raw is not None:
                fh.write(raw)
            else:
                json.dump(
                    {
                        "claudeAiOauth": {
                            "accessToken": token,
                            "expiresAt": expires_at,
                            "refreshToken": "sk-ant-ort01-REFRESH-SECRET",
                            "scopes": ["user:inference"],
                        }
                    },
                    fh,
                )

    def serve(self, responder):
        self.server = StubServer(responder)
        self.addCleanup(self.server.close)
        return self.server

    def run_script(self, *args, endpoint=None):
        env = dict(os.environ)
        env["XDG_RUNTIME_DIR"] = self.runtime
        env["CLAUDE_USAGE_CREDENTIALS"] = self.creds
        env["CLAUDE_USAGE_ENDPOINT"] = endpoint or (
            self.server.url if self.server else "http://127.0.0.1:1/nope"
        )
        for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            env.pop(key, None)
        env["NO_PROXY"] = "*"
        env["no_proxy"] = "*"
        return subprocess.run(
            [sys.executable, SCRIPT, *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )

    def run_json(self, *args, **kwargs):
        result = self.run_script("--json", *args, **kwargs)
        try:
            return json.loads(result.stdout), result
        except json.JSONDecodeError as exc:  # pragma: no cover
            self.fail(
                "--json gav ogiltig JSON (%s)\nstdout=%r\nstderr=%r"
                % (exc, result.stdout, result.stderr)
            )

    def clear_cache(self):
        target = os.path.join(self.runtime, "claude-usage", "usage.json")
        if os.path.exists(target):
            os.unlink(target)


class TestHappyPath(UsageTestCase):
    def test_json_shape_and_generic_parsing(self):
        self.serve(ok_json)
        payload, result = self.run_json("--force")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["stale"])
        self.assertIsNone(payload["error"])
        self.assertFalse(payload["endpoint_documented"])

        keys = [limit["key"] for limit in payload["limits"]]
        # Tidsfönstrade gränser i limits; credits och fönsterlösa nycklar separat.
        self.assertCountEqual(
            keys,
            [
                "five_hour",
                "seven_day",
                "seven_day_opus",
                "seven_day_cowork",
                "thirty_day_fable",
            ],
        )
        # Sortering: kortaste fönstret först, generell före modellspecifik.
        self.assertEqual(keys[0], "five_hour")
        self.assertEqual(keys[1], "seven_day")
        self.assertLess(keys.index("seven_day"), keys.index("seven_day_opus"))
        # wibble_frotz har inget tolkbart tidsfönster -> extras, inte bortkastad.
        self.assertEqual(
            [item["key"] for item in payload["extras"]], ["wibble_frotz"]
        )

    def test_headers_sent(self):
        self.serve(ok_json)
        self.run_json("--force")
        request = self.server.requests[0]
        self.assertEqual(request["authorization"], "Bearer %s" % TOKEN)
        self.assertEqual(request["beta"], "oauth-2025-04-20")
        self.assertTrue(request["user_agent"])

    def test_labels_for_known_and_unknown_keys(self):
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        every = payload["limits"] + payload["extras"]
        labels = {item["key"]: item["label"] for item in every}

        self.assertEqual(labels["five_hour"], "Session (5 h)")
        self.assertEqual(labels["seven_day"], "Vecka – alla modeller")
        self.assertEqual(labels["seven_day_opus"], "Vecka – Opus")
        # Aldrig sedda nycklar får autogenererade namn, inte tomma strängar.
        self.assertEqual(labels["thirty_day_fable"], "30 dagar – Fable")
        self.assertEqual(labels["wibble_frotz"], "Wibble frotz")
        for label in labels.values():
            self.assertTrue(label.strip())

        known = {item["key"]: item["known"] for item in every}
        self.assertTrue(known["five_hour"])
        self.assertFalse(known["thirty_day_fable"])

    def test_percent_and_severity(self):
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        by_key = {limit["key"]: limit for limit in payload["limits"]}

        self.assertAlmostEqual(by_key["five_hour"]["percent"], 42.0)
        self.assertEqual(by_key["five_hour"]["severity"], "ok")
        self.assertEqual(by_key["seven_day"]["severity"], "ok")
        self.assertEqual(by_key["seven_day_opus"]["severity"], "crit")
        self.assertAlmostEqual(payload["max_percent"], 91.5)
        self.assertEqual(payload["max_severity"], "crit")

    def test_severity_thresholds_at_70_and_90(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "five_minute": {"utilization": 69.9},
                        "six_minute": {"utilization": 70},
                        "seven_minute": {"utilization": 89.9},
                        "eight_minute": {"utilization": 90},
                    }
                ),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        got = {limit["key"]: limit["severity"] for limit in payload["limits"]}
        self.assertEqual(got["five_minute"], "ok")
        self.assertEqual(got["six_minute"], "warn")
        self.assertEqual(got["seven_minute"], "warn")
        self.assertEqual(got["eight_minute"], "crit")

    def test_resets_at_formats(self):
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        by_key = {
            item["key"]: item for item in payload["limits"] + payload["extras"]
        }

        # ISO med Z, ISO med offset och epoch-sekunder ska alla ge en epoch.
        # 1786485600 == 2026-08-11T22:00:00Z
        self.assertAlmostEqual(
            by_key["five_hour"]["resets_at_epoch"], 1786485600.0, places=0
        )
        # 1786786200 == 2026-08-15T09:30:00Z — Z och +00:00 ska ge samma svar.
        self.assertAlmostEqual(
            by_key["seven_day"]["resets_at_epoch"], 1786786200.0, places=0
        )
        self.assertAlmostEqual(
            by_key["seven_day_opus"]["resets_at_epoch"],
            by_key["seven_day"]["resets_at_epoch"],
            places=0,
        )
        self.assertAlmostEqual(
            by_key["thirty_day_fable"]["resets_at_epoch"], 1786000000.0, places=0
        )
        # null resets_at ska ge None, inte krascha.
        self.assertIsNone(by_key["wibble_frotz"]["resets_at_epoch"])
        self.assertIsNone(by_key["wibble_frotz"]["resets_in_seconds"])

    def test_epoch_milliseconds_are_detected(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps({"five_hour": {"utilization": 1, "resets_at": 1786000000000}}),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertAlmostEqual(
            payload["limits"][0]["resets_at_epoch"], 1786000000.0, places=0
        )

    def test_credits_rendered_separately(self):
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        credits = payload["credits"]

        self.assertIsNotNone(credits)
        self.assertEqual(credits["key"], "extra_usage")
        self.assertEqual(credits["label"], "Credits")
        fields = {field["key"]: field["value"] for field in credits["fields"]}
        self.assertEqual(fields["used_credits"], "1.5")
        self.assertEqual(fields["credit_limit"], "25")
        self.assertEqual(fields["enabled"], "ja")
        # Credits ligger inte bland gränserna.
        self.assertNotIn("extra_usage", [l["key"] for l in payload["limits"]])

    def test_non_limit_keys_reported_not_dropped(self):
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        reported = {item["key"] for item in payload["unrecognized"]}
        self.assertIn("account_uuid", reported)
        self.assertIn("some_unparsed_object", reported)

    def test_nested_container_is_found(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps({"usage": {"five_hour": {"utilization": 33}}}),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertEqual([l["key"] for l in payload["limits"]], ["five_hour"])
        self.assertAlmostEqual(payload["max_percent"], 33.0)

    def test_text_output_is_readable(self):
        self.serve(ok_json)
        result = self.run_script("--text", "--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout

        self.assertIn("Claude usage", out)
        self.assertIn("Session (5 h)", out)
        self.assertIn("Vecka – Opus", out)
        self.assertIn("Credits", out)
        self.assertIn("42 %", out)
        self.assertIn("█", out)
        self.assertIn("återställs om", out)
        self.assertIn("odokumenterad", out)
        self.assertGreaterEqual(len(out.strip().splitlines()), 8)

    def test_text_is_default_mode(self):
        self.serve(ok_json)
        result = self.run_script("--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Session (5 h)", result.stdout)

    def test_raw_prints_pure_json_to_stdout(self):
        self.serve(ok_json)
        result = self.run_script("--raw", "--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), SAMPLE)


class TestRealWorldShape(UsageTestCase):
    """Formen ett riktigt konto faktiskt returnerar (GNOME 50, aug 2026).

    Skiljer sig från den publikt rapporterade: de modellspecifika
    veckogränserna är skalärer på toppnivån och de riktiga gränserna ligger i
    en lista under `limits`. Credits har ett dussin fält.
    """

    SHAPE = {
        "five_hour": {"utilization": 66, "resets_at": "2026-08-12T22:00:00Z"},
        "seven_day": {"utilization": 27, "resets_at": "2026-08-19T05:00:00Z"},
        # Skalärer, inte objekt — de här tappades tidigare helt.
        "seven_day_opus": 0,
        "seven_day_sonnet": 0,
        "seven_day_cowork": 0,
        "seven_day_oauth_apps": 0,
        "member_dashboard_available": True,
        # De riktiga modellspecifika gränserna, i en lista.
        "limits": [
            {
                "type": "seven_day_opus",
                "utilization": 12,
                "resets_at": "2026-08-19T05:00:00Z",
            },
            {
                "type": "seven_day_sonnet",
                "utilization": 41,
                "resets_at": "2026-08-19T05:00:00Z",
            },
        ],
        "nimbus_quill": {"utilization": 0},
        "extra_usage": {
            "is_enabled": False,
            "monthly_limit": 8500,
            "used_credits": 0,
            "utilization": 0,
            "currency": "EUR",
            "decimal_places": 2,
            "disabled_reason": "out_of_credits",
            "user_disabled": False,
            "spend_limit_reached": False,
            "credits_ever_enabled": True,
            "daily": None,
            "weekly": None,
        },
    }

    def serve_shape(self):
        self.serve(lambda n: (200, "application/json", json.dumps(self.SHAPE)))

    def test_limits_inside_a_list_are_extracted(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        by_key = {limit["key"]: limit for limit in payload["limits"]}

        self.assertIn("seven_day_opus", by_key, "gränser i en lista får inte tappas")
        self.assertIn("seven_day_sonnet", by_key)
        self.assertAlmostEqual(by_key["seven_day_opus"]["percent"], 12.0)
        self.assertAlmostEqual(by_key["seven_day_sonnet"]["percent"], 41.0)
        # Etiketten hämtas från type-fältet, så den blir den kända.
        self.assertEqual(by_key["seven_day_opus"]["label"], "Vecka – Opus")
        self.assertTrue(by_key["seven_day_opus"]["known"])
        self.assertIsNotNone(by_key["seven_day_opus"]["resets_at_epoch"])

    def test_list_derived_limits_sort_with_the_rest(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        keys = [limit["key"] for limit in payload["limits"]]
        self.assertEqual(keys[0], "five_hour")
        self.assertEqual(keys[1], "seven_day")
        # Modellspecifika efter den generella veckogränsen.
        self.assertLess(keys.index("seven_day"), keys.index("seven_day_opus"))
        self.assertLess(keys.index("seven_day"), keys.index("seven_day_sonnet"))

    def test_scalar_shadow_keys_do_not_block_the_list_entries(self):
        """seven_day_opus finns både som skalär och i listan — listan vinner."""
        self.serve_shape()
        payload, _ = self.run_json("--force")
        keys = [limit["key"] for limit in payload["limits"]]
        self.assertEqual(keys.count("seven_day_opus"), 1, "ingen dubblett")
        unrecognized = {item["key"] for item in payload["unrecognized"]}
        self.assertNotIn("seven_day_opus", unrecognized, "ska inte stå som otolkad")
        self.assertNotIn("limits", unrecognized, "listan tolkades ju")

    def test_remaining_scalars_are_reported_with_their_value(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        by_key = {item["key"]: item for item in payload["unrecognized"]}
        # Kvar som otolkade: de skalärer som inte fanns i listan.
        self.assertIn("seven_day_cowork", by_key)
        self.assertEqual(by_key["seven_day_cowork"]["value"], "0")
        self.assertIn("member_dashboard_available", by_key)
        self.assertEqual(by_key["member_dashboard_available"]["value"], "ja")

    def test_credits_display_fields_are_curated(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        credits = payload["credits"]

        # Alla fält finns kvar för den som vill åt dem.
        all_keys = {field["key"] for field in credits["fields"]}
        self.assertIn("decimal_places", all_keys)
        self.assertIn("credits_ever_enabled", all_keys)

        display = [field["key"] for field in credits["display_fields"]]
        self.assertLessEqual(len(display), 4, "credits-raden får inte bli en vägg")
        # Beloppen visas i amount_summary, så de upprepas inte här.
        self.assertIn("disabled_reason", display)
        self.assertNotIn("decimal_places", display)
        self.assertNotIn("credits_ever_enabled", display)
        self.assertNotIn("utilization", display, "dubblerar procentkolumnen")

    def test_keys_without_a_time_window_go_to_extras(self):
        """nimbus_quill och spend är interna kodnamn utan tidsfönster."""
        self.serve_shape()
        payload, _ = self.run_json("--force")

        limit_keys = {limit["key"] for limit in payload["limits"]}
        extra_keys = {item["key"] for item in payload["extras"]}

        self.assertNotIn("nimbus_quill", limit_keys, "hör inte bland gränserna")
        self.assertIn("nimbus_quill", extra_keys, "men får inte tappas")
        by_key = {item["key"]: item for item in payload["extras"]}
        self.assertEqual(by_key["nimbus_quill"]["label"], "Nimbus quill")
        self.assertFalse(by_key["nimbus_quill"]["known"])
        # Alla tidsfönstrade gränser ligger kvar i limits.
        self.assertIn("five_hour", limit_keys)
        self.assertIn("seven_day_opus", limit_keys)

    def test_extras_do_not_drive_the_panel_percentage(self):
        """En okänd nyckel på 99 % får inte färga panelen röd."""
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "five_hour": {"utilization": 10},
                        "mystery_codename": {"utilization": 99},
                    }
                ),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertAlmostEqual(payload["max_percent"], 10.0)
        self.assertEqual(payload["max_severity"], "ok")
        self.assertEqual(
            [item["key"] for item in payload["extras"]], ["mystery_codename"]
        )

    def test_credit_amounts_are_formatted_from_minor_units(self):
        """Bekräftat mot verklig data: 8500 med decimal_places 2 = 85,00 EUR."""
        self.serve_shape()
        payload, _ = self.run_json("--force")
        credits = payload["credits"]

        self.assertEqual(credits["amount_summary"], "0,00 / 85,00 EUR")
        # Fältlistan visar också belopp, inte råa heltal.
        by_key = {field["key"]: field["value"] for field in credits["fields"]}
        self.assertEqual(by_key["monthly_limit"], "85,00 EUR")
        self.assertEqual(by_key["used_credits"], "0,00 EUR")
        # Icke-belopp rörs inte.
        self.assertEqual(by_key["decimal_places"], "2")
        self.assertEqual(by_key["credits_ever_enabled"], "ja")
        # Fälten som gick in i beloppsraden upprepas inte.
        display = [field["key"] for field in credits["display_fields"]]
        self.assertNotIn("monthly_limit", display)
        self.assertNotIn("used_credits", display)
        self.assertNotIn("currency", display)

    def test_amounts_are_left_alone_without_currency_metadata(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "five_hour": {"utilization": 1},
                        "extra_usage": {"monthly_limit": 8500, "used_credits": 0},
                    }
                ),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        credits = payload["credits"]
        self.assertIsNone(credits["amount_summary"], "gissa inte utan currency")
        by_key = {field["key"]: field["value"] for field in credits["fields"]}
        self.assertEqual(by_key["monthly_limit"], "8500")

    def test_text_output_stays_readable(self):
        self.serve_shape()
        result = self.run_script("--text", "--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout

        self.assertIn("Vecka – Opus", out)
        self.assertIn("Vecka – Sonnet", out)
        self.assertIn("0,00 / 85,00 EUR", out)
        self.assertIn("Övrigt", out)
        self.assertIn("Nimbus quill", out)
        # Ingen rad får bli absurt lång.
        longest = max(len(line) for line in out.splitlines())
        self.assertLess(longest, 120, "en rad blev för lång:\n%s" % out)

    def test_list_without_limits_is_reported_not_swallowed(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "five_hour": {"utilization": 1},
                        "notices": ["hej", "hopp"],
                    }
                ),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        by_key = {item["key"]: item for item in payload["unrecognized"]}
        self.assertIn("notices", by_key)
        self.assertEqual(by_key["notices"]["reason"], "lista utan gränser")

    def test_list_entries_without_a_name_field_get_an_index_key(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps({"limits": [{"utilization": 5}, {"utilization": 6}]}),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        # Utan namnfält finns inget tidsfönster att tolka -> extras.
        keys = [item["key"] for item in payload["extras"]]
        self.assertEqual(keys, ["limits_0", "limits_1"])
        for item in payload["extras"]:
            self.assertTrue(item["label"].strip())


class TestKindListShape(UsageTestCase):
    """Formen som faktiskt observerats i ett riktigt svar (aug 2026).

    Posterna i `limits` namnger sig med `kind` — inte `type` — och en
    modellgräns bär sitt namn i ett nästlat `scope`. Utan översättning blir de
    limits_0..2: två dubbletter av toppnycklarna, och en riktig veckogräns som
    tappar sitt tidsfönster och därför varken syns bland gränserna eller
    räknas i panelen.
    """

    SHAPE = {
        "five_hour": {"utilization": 83, "resets_at": "2026-08-12T20:10:00Z"},
        "seven_day": {"utilization": 29, "resets_at": "2026-08-19T03:59:59Z"},
        # Alla dessa är null i riktiga svar — "gäller inte det här kontot".
        "seven_day_opus": None,
        "seven_day_sonnet": None,
        "tangelo": None,
        "amber_ladder": None,
        "member_dashboard_available": False,
        "limits": [
            {
                "group": "session",
                "kind": "session",
                "percent": 83,
                "resets_at": "2026-08-12T20:10:00Z",
                "scope": None,
                "severity": "warning",
            },
            {
                "group": "weekly",
                "kind": "weekly_all",
                "percent": 29,
                "resets_at": "2026-08-19T03:59:59Z",
                "scope": None,
                "severity": "normal",
            },
            {
                "group": "weekly",
                "kind": "weekly_scoped",
                "percent": 55,
                "resets_at": "2026-08-19T04:00:00Z",
                "scope": {"model": {"display_name": "Fable", "id": None},
                          "surface": None},
                "severity": "normal",
            },
        ],
    }

    def serve_shape(self):
        self.serve(lambda n: (200, "application/json", json.dumps(self.SHAPE)))

    def test_kind_maps_onto_the_top_level_keys(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        keys = [limit["key"] for limit in payload["limits"]]

        self.assertEqual(keys.count("five_hour"), 1, "session är ingen ny gräns")
        self.assertEqual(keys.count("seven_day"), 1, "weekly_all är ingen ny gräns")
        self.assertNotIn("limits_0", keys)
        self.assertNotIn("limits_0", [item["key"] for item in payload["extras"]])

    def test_scoped_limit_becomes_a_real_limit_with_the_server_name(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        by_key = {limit["key"]: limit for limit in payload["limits"]}

        self.assertIn("seven_day_fable", by_key, "modellgränsen får inte tappas")
        limit = by_key["seven_day_fable"]
        self.assertAlmostEqual(limit["percent"], 55.0)
        self.assertEqual(limit["label"], "Vecka – Fable")
        # Namnet kom från servern, inte från en gissning -> ingen asterisk.
        self.assertTrue(limit["known"])
        self.assertEqual(limit["window_seconds"], 604800)
        self.assertIsNotNone(limit["resets_at_epoch"])

    def test_scoped_limit_counts_in_the_panel(self):
        """55 % får inte försvinna ur max_percent bara för att den låg i en lista."""
        self.serve_shape()
        payload, _ = self.run_json("--force")
        self.assertAlmostEqual(payload["max_percent"], 83.0)

        percents = {limit["key"]: limit["percent"] for limit in payload["limits"]}
        self.assertAlmostEqual(percents["seven_day_fable"], 55.0)
        self.assertEqual(payload["extras"], [], "inga listposter ska hamna i Övrigt")

    def test_empty_keys_are_separated_from_real_scalars(self):
        self.serve_shape()
        payload, _ = self.run_json("--force")
        by_key = {item["key"]: item for item in payload["unrecognized"]}

        self.assertEqual(by_key["tangelo"]["reason"], "utan värde")
        self.assertEqual(by_key["amber_ladder"]["reason"], "utan värde")
        # En skalär med ett faktiskt värde är något annat och behåller det.
        self.assertEqual(
            by_key["member_dashboard_available"]["reason"], "skalärt värde"
        )
        self.assertEqual(by_key["member_dashboard_available"]["value"], "nej")

    def test_text_output_collapses_the_empty_keys(self):
        self.serve_shape()
        result = self.run_script("--text", "--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout

        self.assertIn("Vecka – Fable", out)
        self.assertNotIn("Limits 0", out, "inga dubbletter av toppnycklarna")
        self.assertNotIn("Övrigt", out)
        # Tio tomma nycklar får inte bli tio rader.
        empty_lines = [line for line in out.splitlines() if "Utan värde:" in line]
        self.assertEqual(len(empty_lines), 1)
        self.assertIn("tangelo", empty_lines[0])
        self.assertIn("seven_day_opus", empty_lines[0])

    def test_unnamed_scopes_do_not_collide(self):
        """Två poster med samma kind men olika scope måste få skilda nycklar."""
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "limits": [
                            {"kind": "weekly_scoped", "percent": 10,
                             "scope": {"model": {"display_name": "Opus"}}},
                            {"kind": "weekly_scoped", "percent": 20,
                             "scope": {"model": {"display_name": "Sonnet"}}},
                        ]
                    }
                ),
            )

        self.serve(responder)
        payload, _ = self.run_json("--force")
        by_key = {limit["key"]: limit["percent"] for limit in payload["limits"]}
        self.assertAlmostEqual(by_key["seven_day_opus"], 10.0)
        self.assertAlmostEqual(by_key["seven_day_sonnet"], 20.0)


class TestLimitAmounts(UsageTestCase):
    """Belopp på gränsraderna. Procenten säger hur mycket, beloppet av vad.

    Två former förekommer i verkliga svar: platta *_dollars på five_hour (som
    dock är null på alla konton vi sett), och en nästlad
    {amount_minor, currency, exponent} på spend.
    """

    def test_nested_minor_units_are_formatted(self):
        def responder(_n):
            return (200, "application/json", json.dumps({
                "spend": {
                    "percent": 0,
                    "used": {"amount_minor": 0, "currency": "EUR", "exponent": 2},
                    "limit": {"amount_minor": 8500, "currency": "EUR", "exponent": 2},
                },
            }))

        self.serve(responder)
        payload, _ = self.run_json("--force")
        entry = payload["extras"][0]
        self.assertEqual(entry["key"], "spend")
        self.assertEqual(entry["amount_summary"], "0,00 / 85,00 EUR")

    def test_flat_dollar_fields_are_formatted(self):
        def responder(_n):
            return (200, "application/json", json.dumps({
                "five_hour": {
                    "utilization": 25,
                    "used_dollars": 1.23,
                    "limit_dollars": 5,
                    "resets_at": "2026-08-13T22:00:00Z",
                },
            }))

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertEqual(payload["limits"][0]["amount_summary"], "1,23 / 5,00 $")

    def test_null_amounts_produce_no_row(self):
        """Riktiga svar har null i alla dollarfält — raden ska inte bli tommare."""
        def responder(_n):
            return (200, "application/json", json.dumps({
                "five_hour": {
                    "utilization": 3,
                    "used_dollars": None,
                    "limit_dollars": None,
                    "remaining_dollars": None,
                    "resets_at": "2026-08-13T22:00:00Z",
                },
            }))

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertIsNone(payload["limits"][0]["amount_summary"])

    def test_limit_without_used_says_max(self):
        def responder(_n):
            return (200, "application/json", json.dumps({
                "five_hour": {"utilization": 10, "limit_dollars": 20},
            }))

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertEqual(payload["limits"][0]["amount_summary"], "max 20,00 $")

    def test_mismatched_currencies_are_not_mixed(self):
        """Två valutor i samma rad vore fel siffra, inte bara ful."""
        def responder(_n):
            return (200, "application/json", json.dumps({
                "spend": {
                    "percent": 5,
                    "used": {"amount_minor": 100, "currency": "USD", "exponent": 2},
                    "limit": {"amount_minor": 8500, "currency": "EUR", "exponent": 2},
                },
            }))

        self.serve(responder)
        payload, _ = self.run_json("--force")
        self.assertEqual(payload["extras"][0]["amount_summary"], "max 85,00 EUR")

    def test_amount_appears_in_text_output(self):
        def responder(_n):
            return (200, "application/json", json.dumps({
                "five_hour": {
                    "utilization": 25,
                    "used_dollars": 1.23,
                    "limit_dollars": 5,
                    "resets_at": "2026-08-13T22:00:00Z",
                },
            }))

        self.serve(responder)
        result = self.run_script("--text", "--force")
        self.assertIn("1,23 / 5,00 $", result.stdout)


class TestCaching(UsageTestCase):
    def test_cache_file_is_0600(self):
        self.serve(ok_json)
        self.run_json("--force")
        path = os.path.join(self.runtime, "claude-usage", "usage.json")
        self.assertTrue(os.path.exists(path))
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_cache_dir_is_0700_under_xdg_runtime_dir(self):
        self.serve(ok_json)
        self.run_json("--force")
        path = os.path.join(self.runtime, "claude-usage")
        self.assertTrue(os.path.isdir(path))
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o700)

    def test_second_call_within_ttl_makes_no_request(self):
        self.serve(ok_json)
        self.run_json("--force")
        self.assertEqual(len(self.server.requests), 1)

        payload, _ = self.run_json()  # utan --force
        self.assertEqual(len(self.server.requests), 1, "TTL respekterades inte")
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["stale"])
        self.assertEqual(payload["source"], "cache")

    def test_source_reflects_whether_a_request_happened(self):
        def responder(n):
            if n == 1:
                return 200, "application/json", json.dumps(SAMPLE)
            return 429, "application/json", "{}"

        self.serve(responder)
        fresh, _ = self.run_json("--force")
        self.assertEqual(fresh["source"], "network")

        cached, _ = self.run_json()  # inom TTL, inget anrop
        self.assertEqual(cached["source"], "cache")

        # Ett anrop som misslyckades räknas som cache — siffrorna är cachade.
        self.age_cache(3600)
        failed, _ = self.run_json()
        self.assertEqual(failed["source"], "cache")
        self.assertTrue(failed["ok"])

    def age_cache(self, seconds):
        path = os.path.join(self.runtime, "claude-usage", "usage.json")
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        for key in ("fetched_at", "last_attempt_at"):
            if isinstance(state.get(key), (int, float)):
                state[key] -= seconds
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)

    def test_force_bypasses_ttl_but_not_the_hard_floor(self):
        self.serve(ok_json)
        self.run_json("--force")
        self.assertEqual(len(self.server.requests), 1)
        # Direkt efter varandra: golvet (15 s) hindrar ett andra anrop.
        self.run_json("--force")
        self.assertEqual(len(self.server.requests), 1)

    def test_cache_never_contains_the_token(self):
        self.serve(ok_json)
        self.run_json("--force")
        path = os.path.join(self.runtime, "claude-usage", "usage.json")
        with open(path, "r", encoding="utf-8") as fh:
            contents = fh.read()
        self.assertNotIn(TOKEN, contents)
        self.assertNotIn("REFRESH-SECRET", contents)


class TestResilience(UsageTestCase):
    """Tillägget ska överleva alla dessa lägen — inget tomt fel."""

    def test_429_serves_cached_data_with_stale_flag(self):
        state = {"n": 0}

        def responder(n):
            state["n"] = n
            if n == 1:
                return 200, "application/json", json.dumps(SAMPLE)
            return 429, "application/json", '{"error":"rate_limited"}'

        self.serve(responder)
        first, _ = self.run_json("--force")
        self.assertTrue(first["ok"])

        # Nollställ tiden i cachen så att TTL inte döljer nästa försök.
        self.age_cache(3600)
        payload, result = self.run_json()

        self.assertGreaterEqual(len(self.server.requests), 2)
        self.assertTrue(payload["ok"], "cachad data ska serveras vid 429")
        self.assertTrue(payload["stale"])
        self.assertEqual(payload["error"]["kind"], "rate_limited")
        self.assertEqual(payload["error"]["retry_after"], "37")
        self.assertEqual(payload["limits"][0]["key"], "five_hour")
        self.assertEqual(result.returncode, 0)

    def test_429_with_no_cache_reports_error_not_crash(self):
        self.serve(lambda n: (429, "application/json", "{}"))
        payload, result = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["stale"])
        self.assertEqual(payload["error"]["kind"], "rate_limited")
        self.assertEqual(payload["limits"], [])
        self.assertEqual(result.returncode, 1)

    def test_network_error_serves_cached_data(self):
        self.serve(ok_json)
        self.run_json("--force")
        self.age_cache(3600)

        # Peka om till en stängd port -> connection refused.
        payload, _ = self.run_json(endpoint="http://127.0.0.1:1/api/oauth/usage")
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["stale"])
        self.assertEqual(payload["error"]["kind"], "network_error")
        self.assertEqual(payload["limits"][0]["key"], "five_hour")

    def test_html_response_is_reported_as_bad_response(self):
        self.serve(
            lambda n: (200, "text/html; charset=utf-8", "<html>Just a moment...</html>")
        )
        payload, _ = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_response")
        self.assertIn("text/html", payload["error"]["message"])
        # Svarskroppen får inte läcka in i felmeddelandet.
        self.assertNotIn("Just a moment", payload["error"]["message"])

    def test_cloudflare_403_html_is_labelled_blocked(self):
        self.serve(lambda n: (403, "text/html", "<html>blocked</html>"))
        payload, _ = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "blocked")

    def test_401_reports_token_problem(self):
        self.serve(lambda n: (401, "application/json", '{"error":"unauthorized"}'))
        payload, _ = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "unauthorized")
        self.assertIn("401", payload["error"]["message"])

    def test_500_serves_cached_data(self):
        def responder(n):
            if n == 1:
                return 200, "application/json", json.dumps(SAMPLE)
            return 503, "application/json", "{}"

        self.serve(responder)
        self.run_json("--force")
        self.age_cache(3600)
        payload, _ = self.run_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "server_error")

    def test_expired_token_still_attempts_and_survives(self):
        self.write_creds(TOKEN, expires_at=1000)  # långt i förflutet
        self.serve(lambda n: (401, "application/json", "{}"))
        payload, result = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "unauthorized")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.server.requests), 1, "borde ändå ha försökt")

    def test_missing_credentials_file(self):
        os.unlink(self.creds)
        self.serve(ok_json)
        payload, result = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "no_credentials")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.server.requests), 0)

    def test_malformed_credentials_file(self):
        self.write_creds(None, raw="{not json")
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        self.assertEqual(payload["error"]["kind"], "bad_credentials")

    def test_credentials_without_token(self):
        self.write_creds(None, raw=json.dumps({"claudeAiOauth": {"expiresAt": 1}}))
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        self.assertEqual(payload["error"]["kind"], "no_token")

    def test_empty_object_response(self):
        self.serve(lambda n: (200, "application/json", "{}"))
        payload, _ = self.run_json("--force")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["limits"], [])
        self.assertIsNone(payload["credits"])
        self.assertIsNone(payload["max_percent"])

    def test_json_array_response_is_rejected_cleanly(self):
        self.serve(lambda n: (200, "application/json", "[1,2,3]"))
        payload, _ = self.run_json("--force")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_response")

    def test_garbage_field_types_do_not_crash(self):
        def responder(_n):
            return (
                200,
                "application/json",
                json.dumps(
                    {
                        "five_hour": {"utilization": "42%", "resets_at": "not-a-date"},
                        "seven_day": {"utilization": None},
                        "eight_day": {"utilization": True},
                        "nine_day": {"utilization": {"nested": 1}},
                    }
                ),
            )

        self.serve(responder)
        payload, result = self.run_json("--force")
        self.assertTrue(payload["ok"])
        by_key = {limit["key"]: limit for limit in payload["limits"]}
        self.assertAlmostEqual(by_key["five_hour"]["percent"], 42.0)
        self.assertIsNone(by_key["five_hour"]["resets_at_epoch"])
        # Otolkbara utilization-värden ger percent=None, inte krasch.
        self.assertIsNone(by_key["seven_day"]["percent"])
        self.assertEqual(by_key["seven_day"]["severity"], "unknown")
        self.assertIsNone(by_key["eight_day"]["percent"])
        self.assertIsNone(by_key["nine_day"]["percent"])
        # Och texten går fortfarande att rendera.
        text = self.run_script("--text")
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("–", text.stdout)

    def test_corrupt_cache_file_is_ignored(self):
        cache_dir = os.path.join(self.runtime, "claude-usage")
        os.makedirs(cache_dir, exist_ok=True)
        with open(os.path.join(cache_dir, "usage.json"), "w", encoding="utf-8") as fh:
            fh.write("{{{ not json")
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        self.assertTrue(payload["ok"])

    def test_works_without_xdg_runtime_dir(self):
        self.serve(ok_json)
        env = dict(os.environ)
        env.pop("XDG_RUNTIME_DIR", None)
        env["CLAUDE_USAGE_CREDENTIALS"] = self.creds
        env["CLAUDE_USAGE_ENDPOINT"] = self.server.url
        env["TMPDIR"] = os.path.join(self.tmp, "fallback")
        os.makedirs(env["TMPDIR"], exist_ok=True)
        result = subprocess.run(
            [sys.executable, SCRIPT, "--json", "--force"],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def age_cache(self, seconds):
        """Backdatera cachen så att TTL/backoff inte döljer nästa försök."""
        path = os.path.join(self.runtime, "claude-usage", "usage.json")
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        for key in ("fetched_at", "last_attempt_at"):
            if isinstance(state.get(key), (int, float)):
                state[key] -= seconds
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)


class TestTokenNeverLeaks(UsageTestCase):
    SECRET_RE = re.compile(re.escape(TOKEN))

    def assert_clean(self, result, label):
        for stream_name, stream in (("stdout", result.stdout), ("stderr", result.stderr)):
            self.assertNotRegex(
                stream or "",
                self.SECRET_RE,
                "token läckte i %s (%s)" % (stream_name, label),
            )
            self.assertNotIn("REFRESH-SECRET", stream or "")

    def test_token_absent_from_all_output_modes(self):
        self.serve(ok_json)
        for args in (("--json", "--force"), ("--text",), ("--raw",)):
            self.assert_clean(self.run_script(*args), " ".join(args))

    def test_token_absent_on_every_failure_mode(self):
        cases = {
            "429": lambda n: (429, "application/json", "{}"),
            "401": lambda n: (401, "application/json", '{"detail":"bad token"}'),
            "html": lambda n: (200, "text/html", "<html>x</html>"),
            "500": lambda n: (500, "application/json", "{}"),
        }
        for label, responder in cases.items():
            with self.subTest(case=label):
                self.clear_cache()
                server = StubServer(responder)
                self.addCleanup(server.close)
                self.server = server
                for args in (("--json", "--force"), ("--text", "--force")):
                    self.assert_clean(self.run_script(*args), "%s %s" % (label, args))

    def test_token_absent_when_endpoint_echoes_it_back(self):
        # Ett elakt svar som innehåller token ska inte kunna skrivas ut ordagrant
        # i felmeddelanden. (Rå data är per definition serverns svar och visas
        # bara i --raw, som användaren uttryckligen ber om.)
        self.serve(
            lambda n: (500, "application/json", json.dumps({"echo": "Bearer " + TOKEN}))
        )
        result = self.run_script("--json", "--force")
        self.assert_clean(result, "echo")

    def test_network_error_message_is_scrubbed(self):
        payload, result = self.run_json(
            "--force", endpoint="http://127.0.0.1:1/api/oauth/usage"
        )
        self.assertEqual(payload["error"]["kind"], "network_error")
        self.assert_clean(result, "network")


class TestCliContract(UsageTestCase):
    def test_help_works(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        for flag in ("--raw", "--json", "--text", "--force"):
            self.assertIn(flag, result.stdout)

    def test_output_modes_are_mutually_exclusive(self):
        result = self.run_script("--json", "--text")
        self.assertEqual(result.returncode, 2)

    def test_json_is_always_parseable_even_on_failure(self):
        os.unlink(self.creds)
        result = self.run_script("--json", "--force")
        payload = json.loads(result.stdout)  # får inte kasta
        self.assertFalse(payload["ok"])
        self.assertIn("error", payload)
        # Fälten som tillägget läser finns alltid.
        for key in ("schema", "ok", "stale", "limits", "credits", "error"):
            self.assertIn(key, payload)

    def test_script_is_executable_and_has_python3_shebang(self):
        self.assertTrue(os.access(SCRIPT, os.X_OK), "bin/claude-usage måste vara +x")
        with open(SCRIPT, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.readline().strip(), "#!/usr/bin/env python3")

    def test_plain_http_endpoint_is_refused(self):
        """Token går som Bearer-header — den får aldrig gå okrypterad.

        CLAUDE_USAGE_ENDPOINT kan sättas av vad som helst som når miljön, så
        kontrollen ligger i skriptet och inte i dokumentationen.
        """
        result = self.run_script(
            "--json", "--force", endpoint="http://example.invalid/usage")
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "insecure_endpoint")
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_localhost_http_is_allowed_for_testing(self):
        """Annars vore testsviten själv omöjlig att köra."""
        self.serve(ok_json)
        payload, _ = self.run_json("--force")
        self.assertTrue(payload["ok"])

    def test_stdlib_only(self):
        with open(SCRIPT, "r", encoding="utf-8") as fh:
            source = fh.read()
        imported = set(re.findall(r"^\s*(?:import|from)\s+([a-zA-Z0-9_.]+)", source, re.M))
        allowed = {
            "__future__", "argparse", "json", "os", "re", "sys", "tempfile",
            "time", "urllib.error", "urllib.parse", "urllib.request", "datetime",
        }
        self.assertTrue(
            imported <= allowed, "otillåtna importer: %s" % (imported - allowed)
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
