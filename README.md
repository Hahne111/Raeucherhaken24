# Räucherhaken24

Onlineshop für Räucherzubehör und Räucherbedarf mit einem Verwaltungsbereich für
den gesamten Betrieb: Katalog und Lager, Verkauf und Belege, Einkauf, Fertigung,
Kasse, Finanzen, Außendienst und Marketing.

Serverseitig gerenderte Seiten mit eigenen URLs – keine Single-Page-Anwendung,
keine Pop-up-Shops. Node 22 mit Express und EJS, Datenbank über das eingebaute
Modul `node:sqlite`. Drei Abhängigkeiten (`ejs`, `express`, `multer`); PDF,
Barcodes und der Mailversand sind selbst geschrieben.

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
„Ports" lässt sich die Adresse auch im Browser öffnen.

`.devcontainer/setup.sh` legt beim Anlegen des Codespace auch eine `.env` an –
mit einem dort erzeugten `SESSION_SECRET` (eine Anmeldung übersteht damit einen
Neustart) und `TRUST_PROXY=1` für die Weiterleitung. `SECURE_COOKIES` bleibt
bewusst auf `0`: im Browser läuft die Weiterleitung über HTTPS, in VS Code
Desktop aber über `http://localhost:3000`, und dort würde ein `Secure`-Cookie
die Anmeldung kommentarlos scheitern lassen. Auf einem echten Server mit HTTPS
gehört dort eine `1` hin. Die `.env` wird nicht committet.

Wichtig: Node 22.5 oder neuer wird benötigt, weil die Datenbank das eingebaute
Modul `node:sqlite` nutzt; ältere Versionen brechen mit einer entsprechenden
Meldung ab. Der Devcontainer bringt Node 22 mit.

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

| Befehl                 | Zweck                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| `npm start`            | Server starten                                                     |
| `npm run dev`          | Server mit automatischem Neustart bei Dateiänderungen              |
| `npm run seed`         | Fehlende Grunddaten ergänzen (bestehende Daten bleiben unberührt)  |
| `npm run reset`        | Katalog- und Bestelldaten löschen und neu anlegen                  |
| `npm run create-admin` | Verwaltungszugang anlegen                                          |
| `npm test`             | Kurztest: Seiten, Zugriffsschutz, CSRF, kompletter Bestellvorgang  |

Prüfskripte je Fachgebiet – jedes legt eine eigene Datenbank in einem
temporären Verzeichnis an und lässt die vorhandenen Daten unberührt:

| Befehl                    | Prüft                                                     |
| ------------------------- | --------------------------------------------------------- |
| `npm run test:rollen`     | Acht Rollen, erlaubte und gesperrte Aktionen               |
| `npm run test:crm`        | Kunden, Berater, Festgebiete, Händler                      |
| `npm run test:kalender`   | Termine, Serien, Erinnerungen, Beratung, Gebietsbücher     |
| `npm run test:belege`     | Rechnung, Lieferschein, Storno, PDF, Versand               |
| `npm run test:einkauf`    | Lieferanten, Bestellung, Wareneingang, Inventur            |
| `npm run test:produktion` | Fertigungsaufträge, Arbeitsschritte, Prototypen            |
| `npm run test:kasse`      | Schicht, Bon, Retoure, Z-Abschluss, Kassenbuch             |
| `npm run test:finanzen`   | Alle zehn Finanzbereiche bis zum Monatsabschluss           |
| `npm run test:vertrieb`   | Provision, Verdienstrechner, Rangliste, Fahrtenbuch        |
| `npm run test:inhalte`    | Newsletter, Bewertungen, Rezepte                           |
| `npm run test:gutscheine` | Wertgutscheine, Serien, Journal, Zahlungsarten             |
| `npm run test:etiketten`  | Vorlagen, Barcodes, Serienlauf, Nachdruck                  |
| `npm run test:markt`      | Marktplatz: Mitgliedschaft, Anzeigen, Moderation           |
| `npm run test:alle`       | Alle Skripte nacheinander                                  |

## Aufbau

```
server.js              Einstieg: Middleware-Kette, Routen, Fehlerseiten
src/
  config.js            Konfiguration und .env-Auswertung (ohne Zusatzpaket)
  schema.sql           Datenbankschema
  db.js                SQLite-Zugriff über node:sqlite; ergänzt beim Start
                       fehlende Spalten, ohne vorhandene Daten anzufassen
  lib/                 Fachlogik, je Aufgabe eine Datei: Katalog, Warenkorb,
                       Bestellungen, Lager, Einkauf, Produktion, Kasse, Belege,
                       PDF, Versand, Finanzen, Provision, Fahrtenbuch, CRM,
                       Kalender, Beratung, Gutscheine, Zahlungsarten, Etiketten,
                       Barcode, Newsletter, Bewertungen, Rezepte, Marktplatz,
                       Systemmail, Sitzungen, CSRF, Rechte, Protokoll
  routes/              shop, cart, checkout, account, market sowie die
                       Verwaltung, nach Fachgebiet in eigene Dateien getrennt
  views/               EJS-Vorlagen (öffentlich, Konto, Verwaltung, Partials)
public/
  css/                 site.css (Shop), admin.css (Verwaltung)
  js/                  boot.js, site.js, hero.js, product.js, cart.js, admin.js
  img/hero             Bühnenfoto (WebP, mehrere Breiten, eigener Kopfausschnitt)
  img/cat, img/products, img/ui   Kachel- und Produktmotive als einzelne Bilddateien
  fonts/               Prata, Playfair Display und Inter, lokal eingebunden
  uploads/             Bilder aus der Verwaltung (nicht in Git)
data/shop.db           Datenbank (nicht in Git)
scripts/               seed, create-admin, Produktimport, 14 Prüfskripte
docs/                  Funktionsmatrix und Fortschrittsbericht
design/referenz.png    Designvorlage, wird nicht ausgeliefert
```

## Seiten

Öffentlich: `/`, `/produkte`, `/kategorie/:slug`, `/produkt/:slug`, `/suche`,
`/angebote`, `/warenkorb`, `/kasse/adresse`, `/kasse/versand`, `/kasse/zahlung`,
`/kasse/pruefen`, `/kasse/danke/:nummer`, `/seite/:slug`, `/ratgeber`,
`/rezept/:slug`, `/markt`, `/markt/anzeige/:id`, `/markt/neu`,
`/markt/mitgliedschaft`, `/newsletter/bestaetigen`, `/newsletter/abmelden`.

Konto: `/konto`, `/konto/anmelden`, `/konto/registrieren`, `/konto/daten`,
`/konto/adressen`, `/konto/bestellungen`, `/konto/bestellungen/:nummer`.

Verwaltung: `/verwaltung` (Anmeldung), danach je nach Rolle

* **Katalog** – `/uebersicht`, `/produkte`, `/kategorien`, `/medien`, `/lager`,
  `/lagerorte`, `/inventur`, `/etiketten`, `/auswertung/produkte`
* **Finanzen** – `/finanzen` mit `/eingangsbelege`, `/bank`, `/offene-posten`,
  `/kreditoren`, `/anlagen`, `/planung`, `/steuern`, `/abschluss`
* **Kasse** – `/kasse`, `/kassen`, `/kassenbuch`
* **Fertigung** – `/produktion`, `/prototypen`
* **Einkauf** – `/lieferanten`, `/einkauf`
* **Verkauf** – `/bestellungen`, `/kunden`, `/belege`, `/versand`, `/gutscheine`,
  `/versandarten`, `/zahlungsarten`
* **Vertrieb** – `/beratung`, `/gebietsbuch`, `/haendler`, `/gebiete`, `/berater`,
  `/provision`, `/verdienst`, `/rangliste`, `/fahrten`, `/fahrzeuge`
* **Inhalte und Marketing** – `/rezepte`, `/bewertungen`, `/newsletter`,
  `/marktplatz`
* **Zusammenarbeit und Konto** – `/termine`, `/nachrichten`, `/einstellungen`,
  `/team`, `/protokoll`

Alle Pfade tragen das Präfix `/verwaltung`. Jeder Bereich hat eigene Seiten für
Übersicht, Detail, Anlegen und Bearbeiten; die Rechteprüfung läuft serverseitig,
ein ausgeblendeter Menüpunkt ersetzt sie nicht.

## Module und Rollen

Acht Rollen mit serverseitig geprüften Rechten: **Admin**, **Kundenservice**,
**Vertrieb**, **Produktion**, **Lager**, **Finanzen**, **Kasse** und
**Redaktion**. Vertriebszugänge sehen ausschließlich die ihnen zugewiesenen
Kunden, Händler und Provisionszeilen.

| Bereich | Was er kann |
| --- | --- |
| CRM | Kundenakte für Privat- und Geschäftskunden mit Konditionen, Tags, Berater, Änderungsprotokoll und Dublettenprüfung; Händler mit Besuchsrhythmus; alle 16 Bundesländer als Festgebiete mit Konfliktanzeige |
| Termine und Beratung | Monat, Woche, Tag und Agenda mit Serien und Erinnerungen; Produktberatung mit Vorschlägen aus echten verfügbaren Artikeln und Übernahme in eine Bestellung; Gebietsbücher mit CSV-Import |
| Verkauf | Bestellungen mit geprüften Statusübergängen; Rechnung, Lieferschein (auch Teilmenge), Gutschrift und Storno mit fortlaufender Nummer, unveränderbarem Snapshot und eigener PDF-Erzeugung; Versand mit Teilmengen und Trackingstatus |
| Lager und Einkauf | Bestände je Variante mit Mindestmenge, Lagerorten und Bewegungsjournal; Lieferanten, Bestellungen, Teil-Wareneingang und Inventur, die nur Differenzen bucht |
| Fertigung | Leitstand als Tabelle und Kanban, Arbeitsschritte mit Person und Zeit; Prototypen mit festem Ablauf und Überführung in die Fertigung |
| Kasse | Schichten, Bon, Rabatte, Retoure, Kassensturz und Z-Abschluss; Trainingsbetrieb strikt getrennt, ohne Bestands- und Kassenbuchbuchung |
| Finanzen | Cockpit, Eingangsbelege, Bank-CSV mit Zuordnung, Kassenbuch, offene Posten mit Mahnstufen, Kreditoren, Konten und Anlagen mit linearer Abschreibung, Planung, Steuerübersicht mit DATEV-Export, Monatsabschluss mit Prüfschritten |
| Vertrieb | Versionierte Provisionsregeln mit festgeschriebenem Rechenweg, Freigabe und Auszahlung; Verdienstrechner; Rangliste mit Sternen; Fahrtenbuch mit lückenloser Kilometerfolge und Reisekostenbelegen |
| Katalog | Produktzentrale mit eigenen Listen, Produktmaske, Kalkulator mit offenem Rechenweg, Naturgewürze als preislose Entwürfe, Etikettenstudio mit eigenen Barcodes (Code 128, EAN-13) |
| Marketing | Newsletter mit Doppelbestätigung und Versandjournal, Bewertungen mit Moderation, Rezepte und Ratgeber, Marktplatz „An- und Verkaufen" mit Mitgliedschaft und Freigabe |
| Gutscheine | Prozent, Festbetrag, Versandfrei und Wertgutschein mit Restwert über mehrere Bestellungen; Serien, Journal und Rückbuchung bei Storno |

Der aktuelle Stand je Funktion steht in `docs/funktionsmatrix.md` – mit URLs,
Rollen, Geschäftsregeln und dem jeweiligen Prüfnachweis.

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

Diese Punkte sind im Programm vorbereitet und **sichtbar gesperrt**. Sie sind
nicht „fast fertig": ohne den genannten Zugang, die Hardware oder die fachliche
Abnahme laufen sie nicht, und das Programm behauptet das Gegenteil an keiner
Stelle.

| Bereich | Was fehlt | Verhalten heute |
| --- | --- | --- |
| **Systemmail** | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Jede Nachricht liegt sichtbar gesperrt im Ausgangskorb und nennt die fehlenden Angaben. Betrifft Terminerinnerungen, Mahnungen, Lieferantenbestellungen und Newsletter |
| **Zahlungsanbieter** | Vertrag und Zugangsdaten, vor allem aber eine geprüfte Anbindung | Vorkasse, Rechnung und Nachnahme laufen. PayPal und Kreditkarte lassen sich **nicht** aktivieren; die Verwaltung nennt die nötigen Umgebungsvariablen |
| **Kasse im Livebetrieb** | Technische Sicherheitseinrichtung (TSE) | Es ist **keine TSE angebunden**. Der Livebetrieb bleibt gesperrt, der Trainingsbetrieb läuft vollständig – ohne Bestands- und Kassenbuchbuchung |
| **Versandetiketten** | DHL-/DPD-Vertrag und `<CODE>_API_USER`, `_KEY`, `_ACCOUNT` | Sendungen, Teilmengen und Trackingstatus funktionieren; die Labelerzeugung wird abgewiesen und protokolliert |
| **Steuern** | ELSTER-Anbindung | Es besteht **keine Übertragung an ELSTER**. Die Steuerseite sagt das ausdrücklich. Der DATEV-Export ist ein Vorschlag und mit der Steuerberatung abzustimmen |
| **Banking** | Kontoabruf per FinTS oder Bank-API | Der CSV-Import mit Dublettenschutz und Zuordnung funktioniert; ein automatischer Abruf fehlt |
| **Etikettendrucker** | Treiber oder Druckerprofil | Gedruckt wird über den Browser auf ein millimetergenaues A4-Raster |
| **Marktplatz-Beitrag** | Online-Zahlung | Die Verwaltung schaltet die Mitgliedschaft nach Zahlungseingang von Hand frei |
| **Kartendienst** | Konto bei einem Routendienst | Fahrtenbuch und Termine funktionieren ohne Karte; Tourenplanung und HSN/TSN-Suche fehlen |

Fachlich extern, nicht durch Programmierung zu erledigen: Abnahme nach GoBD,
Kassenführung, Fahrtenbuch und die Zuordnung der Konten – das gehört zur
Steuerberatung.

## Was noch einzutragen ist

* **Firmendaten**: `shop.company`, `shop.tax_id`, `shop.vat_id`, `shop.register`,
  `shop.bank` und `shop.url` sind absichtlich leer. Ohne sie sind Belege nicht
  vollständig. Einzutragen unter Einstellungen.
* **Rechtstexte**: Impressum, Datenschutz, AGB und Widerruf enthalten Platzhalter
  und müssen in der Verwaltung unter Einstellungen → `seiten` ergänzt werden.
* **Preise und Produktangaben** stammen aus dem Beispieldatensatz und sind noch
  keine bestätigten Geschäftsdaten. Die 135 Naturgewürze bleiben Entwürfe,
  solange kein gültiger Preis eingetragen ist.
