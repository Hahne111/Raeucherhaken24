# Orgaboard-Übernahme – Fortschrittsbericht

Fortlaufender Bericht zur Übernahme der Orgaboard-Module aus
`RH24-SHOP-ORGABOARD-NEUSTE-VERSION-V2026.21.0-FINAL.zip` in diesen Shop.
Zweck: nach einer Unterbrechung exakt an der letzten Stelle weiterarbeiten.

Zielrepository: `https://github.com/Hahne111/Raeucherhaken24`
Arbeitsbranch: `claude/inspiring-tesla-ukptb8`
Stand dieses Berichts: 13.09.2026, Basis `c294e6e`

## 1. Aktueller Blocker: Die Quelle fehlt

**Die ZIP ist in der Arbeitsumgebung nicht erreichbar.** Damit fehlt die
verbindliche Referenz für `index.php`, `admin-v9911.js?v=2026.21.0`,
`bootstrap.php`, `api.php`, `api-guard.php`, `cockpit.php`, `finance-v91.php`,
`finance-api.php`, `pos-api.php`, `labels-v96.php`, `label-api.php`,
`vehicle-v98.php`, `loyalty-v2.php`, `orgaboard/plus-api.php` und die
Installations-/Rollout-Hinweise.

Gesucht wurde in: Upload-Verzeichnis der Sitzung (enthält nur ein Bildschirmfoto),
`/root`, `/home`, `/tmp`, `/workspace`, `/mnt` (kein Treffer außer einem
Chromedriver-Archiv), im Arbeitsverzeichnis, in der vollständigen Git-Historie
aller Branches (keine `.php`-Datei, kein `orgaboard/`, kein `admin-v…js`) sowie
in den Remote-Branches (`main`, `claude/inspiring-tesla-ukptb8`,
`codex/shop-system-20260912`).

Bis die Datei vorliegt, werden **keine** ZIP-Funktionen nachgebaut. Ranglogik,
Provisionsregeln, Rangcodes, Margenuntergrenzen, Etikettenvorlagen,
Druckerprofile, Zahlungsanbieter-Konfiguration und TSE-Gateway hängen an
Detailregeln, die nur die Quelle belegt. Geraten wäre das Gegenteil von „1:1".

### Wie die Datei hierher kommt

1. **In den Chat hochladen** – einfachster Weg.
2. **Oder in einen eigenen Branch committen**, z. B.

   ```bash
   git checkout -b orgaboard-quelle
   mkdir -p referenz
   cp RH24-SHOP-ORGABOARD-NEUSTE-VERSION-V2026.21.0-FINAL.zip referenz/
   git add referenz && git commit -m "Orgaboard-Quelle als Referenz" && git push -u origin orgaboard-quelle
   ```

   Der Branch wird nur gelesen, nicht nach `main` geführt.
3. **Oder entpackt** unter `referenz/orgaboard/` – dann ist der Loader direkt
   lesbar.

Hinweis: Wenn die ZIP Zugangsdaten, Schlüssel oder echte Kundendaten enthält,
gehört sie nicht in das Repository. Dann bitte hochladen statt committen.

## 2. Abgleich: Was dieser Shop heute schon kann

Der neue Shop ist kein leeres Feld. Grundlage: 97 Tabellen, 37 Bibliotheken,
20 Routendateien, 8 Rollen, 14 Prüfskripte (`npm run test:alle`).
Die Spalte „ZIP-Abgleich" ist bewusst offen, solange die Quelle fehlt.

| Modul laut Auftrag | Stand im neuen Shop | Offen / zu prüfen gegen die ZIP |
| --- | --- | --- |
| A Chef-Dashboard | `/verwaltung/uebersicht` mit Umsatz heute/Monat, Aufträgen, Versand, Produkten, Kunden, Gutscheinen, Bestand, Protokoll | Tagesbrief, 7/30-Tage und Jahr mit Vorperiodenvergleich, Warnungen nach Dringlichkeit, Nachbestellbedarf, Zahlungslage, Systemzustand, Favoriten, globale Suche/Befehlspalette |
| B Kunden & CRM | Kundenakte mit Typ, Status, Firma, USt-ID, Zahlungsziel, Rabatt, Tags, Berater, Änderungsprotokoll, Dublettenprüfung; Berater sehen nur eigene Kunden | Anrede, Ansprechpartner, Mobil, Website, Steuernummer, bevorzugter Kontakt, Quelle, Einwilligung, Prüfflag, Adressprüfung |
| C Dienstgrade / Bonus V2 | **fehlt vollständig** | gesamte Ranglogik, Punktejournal, Rangcodes, Kapitänsrabatt, Margenprüfung, Inaktivität, Tageslauf |
| D Termine | Monat/Woche/Tag/Agenda, Serien, Erinnerungen je Empfänger einmalig, Druck, CRM- und Händlerbezug | Terminarten, Priorität, Farbe, Online-Link, Teilnehmer, Aufgaben, Pufferzeiten, Vorlagen, Ergebnis/nächste Aktion |
| E Interne Nachrichten | `admin-messages.js` vorhanden | Mehrfachempfänger, Verlauf, Suche, gelesen/ungelesen gegen ZIP prüfen |
| F Produktberatung | Bedarf, Budget, Vorschläge aus echten aktiven Artikeln, Übernahme in Bestellung mit Kundenrabatt | Einsatzbereich/Wünsche-Felder gegen ZIP |
| G Gebietsbücher | Gebietsbücher, Kontaktstatus, Wiedervorlage, CSV-Import mit Dublettenschutz, Druck | Branchen-Scout/OSM-Recherche, Teilimporte, Fortsetzen |
| H Bestellungen | Liste, Detail, Positionen, Status serverseitig geprüft, Storno mit Bestands- und Gutscheinrückbuchung | Herkunftskanal, Provisionszuordnung sichtbar, Retoure/Erstattung als Ablauf, CSV-Export |
| I Kasse & POS | Schichten, Bon, Rabatte, Retoure, Kassensturz, Z-Abschluss, Training/Live getrennt, Kassenbuch | geparkte Bons, Zahlarten-Vielfalt, Barcode-Hardware, Fiskal-/TSE-Gateway der ZIP |
| J Zahlungsarten | Verwaltung mit Gebühr, Betragsrahmen, Anbietersperre; Vorkasse/Rechnung/Nachnahme live | Klarna, Amazon Pay, Sparkasse, Wero, Stripe, Google/Apple Pay, Mollie, SEPA; Webhooks, Erstattung |
| K Rechnungen & Lieferscheine | Rechnung, Lieferschein (Teilmenge), Gutschrift, Storno, Nummernkreise, unveränderbarer Snapshot, eigene PDF | Rechnungsprofil/Pflichtangaben, E-Mail-Versandhistorie, Versionen |
| L Versand & Tracking | Sendungen, Teilmengen, Pakete, Trackingstatus, Auftragsstatus synchron | DHL/DPD-Konfiguration und Verbindungstest der ZIP, Etikettenerzeugung |
| M Finanzen | alle zehn Bereiche: Cockpit, Eingangsbelege, Bank-CSV, Kassenbuch, offene Posten mit Mahnstufen, Kreditoren, Konten/Anlagen mit AfA, Planung, Steuern/DATEV, Monatsabschluss | Kontenrahmen SKR03/SKR04, Kostenstellen, Budgets/Fixkosten/Dauerposten, EÜR, Periodensperre mit protokollierter Wiederöffnung, Belegprüfung per Datei-Hash |
| N Produktion | Leitstand Tabelle und Kanban, Schritte mit Person und Zeit, Status abgeleitet | Stationsliste der ZIP (Zuschnitt, Biegen, Spitze/Schleifen, Löten …), Arbeitsplatz, ausführende Person getrennt, Tagesliste/Ausführungsnachweis |
| O Prototypen | Ablauf ohne Sprünge, Dateien, Überführung genau einmal | Zahlungsstatus mit echtem Finanzbezug |
| P Lagerraum | Bestände, Mindestmengen, Lagerorte, Journal, Wareneingang, Inventur, eine Bestandswahrheit | grafischer Lagerraum, Zonen, Packmittel, Reichweite, Verbrauchsauswertung |
| Q Lieferanten / Einkauf | Stamm, Einkaufsartikel, Bestellungen, Bestellmail, Teil-Wareneingang, Mindestbestellwert | Artikel-Autocomplete mit letztem EK, Beleg-Upload je Zeile, Kennzahlen offen/überfällig/Monats-EK, CSV, Kreditorenbezug |
| R Produktionsteam | Rolle `produktion` mit eigenen Rechten, Schrittübernahme protokolliert | eigene Teamverwaltung, letzte Ausführung, Aktivitätsnachweis |
| S Produktzentrale | Listen, Suche, Filter, Sortierung, Einzelbearbeitung, Freigabe nur mit kaufbaren Daten | Barcode, Gewicht/Versandgewicht, Verpackung, Umsatz je Artikel, sichere Mehrfachbearbeitung |
| T Etikettenstudio | Vorlagen mit mm-Maßen, A4-Prüfung, Code 128 und EAN-13 als SVG, Vorschau, Serienlauf, Druck, Nachdruck | Editor mit Live-Vorschau, Druckerprofile, Favoriten/Duplikate, CSV-Auswahl, Testdruck, Medienformate der ZIP |
| U Produkt-Baukasten | Produktmaske mit Preis, Varianten, Bild, Status; Veröffentlichung validiert | geführter mehrstufiger Ablauf, Merkmale, Verpackungsmaße, SEO, Shopvorschau |
| V Naturgewürze | eigene Übersicht, 135 preislose Entwürfe, Freigabe erst mit Preis | Abgleich gegen ZIP-Bestand über stabile SKU |
| W Gutscheine | Prozent, Fest, Versand, Wertgutschein mit Restwert, Serien, Journal, Rückbuchung, CSV | Kundenzuordnung, erlaubte Kanäle/Kategorien/Produkte, Nachricht, Druck, E-Mail |
| X Analyse & Kalkulator | Verkaufsanalyse mit Druck; Kalkulator mit offenem Rechenweg und bestätigter Preisübernahme | Kategorie-/Zeitraumtiefe, Langsamdreher, Retourenquote |
| Y Vertrieb | Provision versioniert mit Rechenweg, Freigabe, Auszahlung, Verdienstrechner, Rangliste mit Sternen, Vertriebskalender | **Staffel 5 / 7,5 / 10 / 12,5 / 15 / 20 % der ZIP**, Teamleiteranteil, Regionalmanager, Planzahlen, Jahresübersicht |
| Z Festgebiete, Händler, Fahrtenbuch | 16 Bundesländer mit Konfliktanzeige, Händlerakte mit Besuchsrhythmus, Fahrtenbuch mit lückenloser km-Folge, Belege, CSV, Druck | Entwurf/Abschluss mit Korrekturhistorie, Tourverknüpfung, Google-Maps-Routen, HSN/TSN |
| AA Shop & Marketing | Marktplatz mit Mitgliedschaft und Moderation, Newsletter mit Double-Opt-in, Bewertungen mit Freigabe, Rezepte/Ratgeber | Newsletter-Gutschein ohne Doppelvergabe, Anzeigen-Nachrichten, Smoky/KI, **saisonale Shop-Themes** |
| AB System & Konto | 8 Rollen serverseitig, Zugänge, Einstellungen, Protokoll, eigenes Profil | Rechte-Zentrale mit Einzelrechten als Oberfläche, Einladungs-/Systemmailstatus, Hilfecenter, PWA |

### Gestaltung

Die Verwaltung ist heute hell mit dunkelblauer Seitenleiste. Die vom Auftrag
geforderte maritime Kommandozentrale (dunkles Marineblau, Messing-/Kupferakzente,
helle Arbeitsflächen) ist **noch nicht** umgesetzt und braucht die ZIP als
Vorlage. Der öffentliche Shop bleibt davon unberührt.

## 3. Nächste Schritte, sobald die ZIP vorliegt

1. Loader lesen: `index.php` → `admin-v9911.js?v=2026.21.0` → tatsächlich
   aufgerufene Endpunkte in `api.php`/`api-guard.php`. Erst danach wird eine
   Datei als verbindlich erklärt; `orgaboard/` und `admin-v…js`-Archive gelten
   bis zum Beweis als Altstände.
2. Funktionsmatrix je Modul vervollständigen: Seiten, Felder, Aktionen,
   Geschäftsregeln, Rollen, Daten, Shopbezug, Referenzdatei, Testfälle.
   Jeder Button gegen seine echte Aktion, jeder Endpunkt gegen seine
   serverseitige Rechteprüfung.
3. Umsetzung in Etappen, je Etappe ein Commit mit eigenem Prüfskript.
   Reihenfolge nach Abhängigkeit: erst C (Dienstgrade, weil Bestellung und
   Erstattung daran hängen), dann die Lücken in Y, Q, M, I, J, T, AA, AB.
4. Verknüpfte Abläufe aus Abschnitt 4 des Auftrags als Integrationstests.

## 4. Verlauf

| Datum | Etappe | Ergebnis |
| --- | --- | --- |
| 13.09.2026 | Quelle prüfen, Abgleich anlegen | ZIP nicht erreichbar, Übernahme blockiert; Bestandsaufnahme des neuen Shops steht |
