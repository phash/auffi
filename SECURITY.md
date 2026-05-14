# Security Policy

## Supported Versions

Auffi tracks `main` — the production deployment at `https://auffi.app`
runs whatever the latest tagged release is plus security follow-ups.
We do not maintain LTS branches.

| Version | Supported          |
|---------|--------------------|
| latest (`main`) | ✅ |
| < latest        | ❌ — bitte updaten |

## Reporting a Vulnerability

Bitte sicherheitsrelevante Bugs **nicht** als öffentliches Issue
melden, sondern privat:

- **GitHub Security Advisory** (bevorzugt):
  https://github.com/phash/auffi/security/advisories/new
- E-Mail: `phash@phash.de`

Wir antworten in der Regel innerhalb von 72 Stunden. Eine erste
Einschätzung (bestätigt / kein Sicherheitsproblem / brauche mehr
Details) kommt innerhalb einer Woche.

Bekannte sichere Surfaces sind in `docs/security-review-2026-05.md`
und `docs/security-review-2026-05-14-feedback.md` dokumentiert. Wenn
dein Befund über das hinausgeht, was die Reviews abdecken, freuen
wir uns über den Hinweis.

## Was als Sicherheitsproblem zählt

- Auth-Bypass (Session-Cookie-Schwächen, Bearer-Token-Spoofing, …)
- Code-Injection (XSS, SQL, Command, Template)
- DoS-Vektoren mit asymmetrischem Kosten-Verhältnis (z. B. argon2-
  Burns ohne Rate-Limit)
- Daten-Leaks personenbezogener Daten an Unbefugte
- Crypto-Misuse (DTLS-SRTP-Disable, Klartext-Tokens, schwache
  Passwort-Hashes)
- CSRF / Click-Jacking auf authentifizierte Endpunkte

Keine Sicherheitsprobleme (aber gerne reguläre Issues):

- UI-/UX-Defects ohne Datenflussfolgen
- Best-Practice-Verstöße ohne konkrete Ausnutzbarkeit
- Feature-Anfragen

## Belohnung

Auffi ist ein Hobbyprojekt unter AGPL-3.0; ein Bug-Bounty-Budget
gibt es nicht. Wir nennen Reporter im Security-Advisory namentlich
(soweit gewünscht) und im nächsten Release-Changelog.
