# Räucherhaken24

Onlineshop für Räucherzubehör und Räucherbedarf mit geschütztem Verwaltungsbereich.
Serverseitig gerenderte Seiten mit eigenen URLs – keine Single-Page-Anwendung, keine Pop-up-Shops.

## Schnellstart

```bash
npm install
cp .env.example .env          # danach SESSION_SECRET und ADMIN_SETUP_TOKEN eintragen
npm run seed                  # Kategorien, Produkte, Versandarten, Gutscheine, Texte
npm start                     # http://localhost:3000
```

Nützliche Zufallswerte erzeugen:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### In GitHub Codespaces starten

Der Codespace bringt über `.devcontainer/devcontainer.json` bereits Node 22 mit
und führt `npm install` sowie `npm run seed` beim Anlegen aus. Danach genügt:

```bash
npm start
```

Codespaces leitet Port 3000 automatisch weiter und öffnet die Vorschau; über
„Ports" lässt sich die Adresse auch im Browser öffnen. Ohne `.env` läuft der
Shop im Entwicklungsmodus mit einem Sitzungsschlüssel, der bei jedem Neustart
wechselt – dann wird man nach einem Neustart abgemeldet. Für dauerhafte
Sitzungen einmalig:

```bash
printf 'SESSION_SECRET=%s\n' "$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" > .env
```

Läuft der Shop hinter der HTTPS-Weiterleitung von Codespaces, zusätzlich
`TRUST_PROXY=1` in die `.env` schreiben. Wichtig: Node 22.5 oder neuer wird
benötigt, weil die Datenbank das eingebaute Modul `node:sqlite` nutzt; ältere
Versionen brechen mit einer entsprechenden Meldung ab.

### Ersten Verwaltungszugang anlegen

Zwei Wege, beide ohne Passwort im Code oder in Git:

1. **Über die Kommandozeile** (empfohlen)

   ```bash
   npm run create-admin -- --email chef@example.de --name "Vorname Nachname"
   # Passwort wird abgefragt; alternativ: ADMIN_PASSWORD=... npm run create-admin -- --email ...
   ```

2. **Über den Browser**: Solange kein Zugang existiert, ist `/verwaltung/einrichten`
   erreichbar. Ist `ADMIN_SETUP_TOKEN` in der `.env` gesetzt, muss dieses Token
   eingegeben werden. Nach dem ersten Zugang sperrt sich die Seite selbst.

Anmeldung danach unter `/verwaltung`. Der Einstieg ist im Shop unauffällig über das
Anker-Symbol in der Fußzeile erreichbar; der Schutz selbst läuft serverseitig
(Sitzung in der Datenbank, signiertes HttpOnly-Cookie, Sperre nach sechs Fehlversuchen).

## Skripte

| Befehl                 | Zweck                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `npm start`            | Server starten                                                        |
| `npm run dev`          | Server mit automatischem Neustart bei Dateiänderungen                 |
| `npm run seed`         | Fehlende Grunddaten ergänzen (bestehende Daten bleiben unberührt)     |
| `npm run reset`        | Katalog- und Bestelldaten löschen und neu anlegen                     |
| `npm run create-admin` | Verwaltungszugang anlegen                                             |
| `npm test`             | Kurztest: Seiten, Zugriffsschutz, CSRF, kompletter Bestellvorgang     |

## Aufbau

```
server.js              Einstieg: Middleware-Kette, Routen, Fehlerseiten
src/
  config.js            Konfiguration und .env-Auswertung (ohne Zusatzpaket)
  schema.sql           Datenbankschema
  db.js                SQLite-Zugriff über node:sqlite
  lib/                 Fachlogik: Katalog, Warenkorb, Bestellungen, Adressen,
                       Sitzungen, CSRF, Anmeldung, Einstellungen, Protokoll
  routes/              shop, cart, checkout, account, admin
  views/               EJS-Vorlagen (öffentlich, Konto, Verwaltung, Partials)
public/
  css/                 site.css (Shop), admin.css (Verwaltung)
  js/                  boot.js, site.js, hero.js, product.js, cart.js, admin.js
  img/hero             Bühnenfoto (WebP, mehrere Breiten, eigener Kopfausschnitt)
  img/cat, img/products, img/ui   Kachel- und Produktmotive als einzelne Bilddateien
  fonts/               Prata, Playfair Display und Inter, lokal eingebunden
  uploads/             Bilder aus der Verwaltung (nicht in Git)
data/shop.db           Datenbank (nicht in Git)
scripts/               seed, create-admin, smoke-test
```

## Seiten

Öffentlich: `/`, `/produkte`, `/kategorie/:slug`, `/produkt/:slug`, `/suche`,
`/angebote`, `/warenkorb`, `/kasse/adresse`, `/kasse/versand`, `/kasse/zahlung`,
`/kasse/pruefen`, `/kasse/danke/:nummer`, `/seite/:slug`.

Konto: `/konto`, `/konto/anmelden`, `/konto/registrieren`, `/konto/daten`,
`/konto/adressen`, `/konto/bestellungen`, `/konto/bestellungen/:nummer`.

Verwaltung: `/verwaltung` (Anmeldung), `/verwaltung/uebersicht`, `/verwaltung/produkte`,
`/verwaltung/kategorien`, `/verwaltung/bestellungen`, `/verwaltung/kunden`,
`/verwaltung/gutscheine`, `/verwaltung/versandarten`, `/verwaltung/einstellungen`,
`/verwaltung/medien`, `/verwaltung/protokoll`, `/verwaltung/team`.

## Bestand und Bestellungen

Bestände hängen an der Variante. Beim Bestellen läuft alles in einer Transaktion:
Verfügbarkeit prüfen, Gutschein erneut prüfen, Bestellung schreiben, Bestand mit
`UPDATE ... WHERE stock >= menge` buchen. Schlägt die Buchung fehl, wird die
gesamte Bestellung zurückgerollt – Überverkäufe sind damit ausgeschlossen.
Ein Storno in der Verwaltung bucht den Bestand zurück.

## Startseite und Bewegung

Die Bühne besteht aus zwei deckungsgleichen Schichten in
`src/views/partials/scene.ejs`:

1. **Foto** (`public/img/hero/szene-*.webp`) – der Bildinhalt der Designvorlage,
   in mehreren Breiten als WebP. Alle in der Vorlage eingebrannten Texte sind
   entfernt; die Flächen hinter Kachel- und Kartenreihe wurden aus echten
   Wasser- und Holzausschnitten neu aufgebaut. Sämtliche Beschriftungen,
   Schaltflächen und Produktdaten sind eigene HTML-Elemente.
2. **Bewegungsebene** – ein schlankes SVG über dem Foto. Bewegt werden
   ausschließlich `transform` und `opacity`:
   * Leuchtturm: ein Rotor dreht den Lichtkegel um die Laterne des Fotos; drei
     gestaffelte Keile und ein Halo erzeugen Tiefe in Nebel und Gischt.
   * Rauch: acht Schwaden in unterschiedlichen Geschwindigkeiten steigen über
     den hängenden Fischen auf, verwirbeln, ziehen mit dem Wind und laufen
     weich aus.
   * Wasser und Luft: Gischtstöße vor der Hafenmauer, ziehende Möwen.
   * Tiefe: `hero.js` verschiebt Foto und Bewegungsebene beim Scrollen
     unterschiedlich stark.

Foto und SVG nutzen dieselbe Zuschnittregel (`object-fit: cover` bzw.
`preserveAspectRatio="xMidYMid slice"`) und bleiben dadurch in jeder Größe
deckungsgleich. SVG-Filter und `mix-blend-mode` kommen nicht vor, weil beides
zum Neuzeichnen der gesamten Fläche zwingt; weiche Kanten entstehen über
Verläufe.

Unterhalb von 1120 px Breite zeigt das Foto einen eigenen Kopfausschnitt
(`szene-kopf-*.webp`), der bei Leuchtturm und Räucherkate liegt – so bleiben
Lichtkegel und Rauch auch auf dem Telefon sichtbar. Bei
`prefers-reduced-motion: reduce` steht alles still, Lichtkegel und Rauch
bleiben als stimmiges Standbild sichtbar.

Die Designvorlage selbst liegt unter `design/referenz.png`, also außerhalb von
`public/` – sie wird nie ausgeliefert und ist nur Quelle für die einzelnen
Bildmotive.

## Sicherheit

* Passwörter als PBKDF2-SHA256 mit 120.000 Iterationen und Zufallssalz.
* Sitzungen in der Datenbank, Cookie-Wert per HMAC signiert, HttpOnly und SameSite=Lax.
  Getrennte Sitzungen für Shop und Verwaltung; ID-Wechsel bei jeder Anmeldung.
* CSRF-Token für alle schreibenden Anfragen.
* Content-Security-Policy ohne `unsafe-inline` für Skripte; keine Inline-Handler.
* Verwaltungsseiten mit `noindex` und `no-store`.
* Uploads auf PNG, JPG, WEBP, SVG, GIF bis 4 MB begrenzt, Dateinamen werden neu vergeben.
* Änderungen in der Verwaltung landen im Protokoll (`/verwaltung/protokoll`).

Für den produktiven Betrieb hinter HTTPS zusätzlich `TRUST_PROXY=1` und
`SECURE_COOKIES=1` setzen.

## Noch nicht angebunden

* **Zahlung**: Es gibt Vorkasse, Rechnung und Nachnahme als Auswahl, aber keine
  Anbindung an einen Zahlungsanbieter. Dafür fehlen Zugangsdaten.
* **E-Mail**: Bestellbestätigungen werden nicht versendet. Dafür fehlen SMTP-Daten.
* **Rechtstexte**: Impressum, Datenschutz, AGB und Widerruf enthalten Platzhalter
  und müssen in der Verwaltung unter Einstellungen → `seiten` ergänzt werden.
* **Preise und Produktangaben** stammen aus dem Beispieldatensatz und sind noch
  keine bestätigten Geschäftsdaten.
